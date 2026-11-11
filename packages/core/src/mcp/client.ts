// Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0):
// initialize → notifications/initialized → tools/list → tools/call.
// Tool calls ask for progress (MCP 2025-06-18 progress utility): a report
// restarts the wait, up to an overall limit; a call that times out or is
// stopped is cancelled at the server (notifications/cancelled).
// External tools are added to the tool registry under source `mcp:<name>`.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Tracer } from '../trace.ts';
import type { Tool, ToolRegistry } from '../tools/types.ts';
import { withNetworkEnv } from '../net.ts';
import type { SamplingGrant } from '../sampling.ts';
import { childEnv } from '../util.ts';

export interface McpServerConfig {
  /** Short name; tools appear as `<name>__<tool>`. */
  name: string;
  command: string;
  args?: string[];
  /**
   * Extra variables for the server (passed as given, after the network
   * settings: the app's proxy and trusted certificates, see networkChildEnv).
   */
  env?: Record<string, string>;
  /**
   * Which host variables the server inherits: a whitelist (default: PATH,
   * SystemRoot, TEMP/TMP, USERPROFILE, APPDATA, LOCALAPPDATA, COMPUTERNAME,
   * USERNAME, proxy variables, ...) or 'all'. Secret-looking names (model
   * keys, tokens) never pass.
   */
  inheritEnv?: 'all' | string[];
  cwd?: string;
  /**
   * How long a request may go without an answer. Default 60 s. A tool call
   * carries a progress token, and each progress notification for it starts
   * the wait again, so a long tool that keeps reporting progress can finish.
   */
  timeoutMs?: number;
  /**
   * The longest a request may run even while the server keeps reporting
   * progress (the MCP spec asks for such a maximum). Default 60 min; never
   * shorter than timeoutMs.
   */
  maxCallMs?: number;
  /**
   * At most this many tool calls run in the server at once; later ones wait
   * their turn in order. Waiting counts toward neither timeoutMs nor
   * maxCallMs: both start when the call is sent. Default: no limit.
   */
  concurrency?: number;
  /**
   * Called once when the server process ends. `expected` is true when it was
   * stopped by disconnect()/close(); otherwise it crashed or quit by itself.
   */
  onExit?(info: { code: number | null; stderrTail: string; expected: boolean }): void;
  /** Receives the server's stderr as it arrives (e.g. to write a plugin log). */
  stderrLog?(chunk: string): void;
  /**
   * The server may use the user's models (MCP sampling): set by the plugin
   * manager for plugins whose manifest asks for it. Runtime.connectMcp answers
   * the requests; without it the client does not offer sampling.
   */
  sampling?: SamplingGrant;
  /** Answers sampling/createMessage (set by Runtime.connectMcp from `sampling`). */
  onSampling?(params: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
}

/** One notifications/progress from the server for a running call. */
export interface McpProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface McpRequestOptions {
  signal?: AbortSignal;
  /** Ask the server for progress (adds _meta.progressToken); each report restarts the wait. */
  onProgress?(p: McpProgress): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** Waits for the next sign of life (an answer or a progress report). */
  idle: ReturnType<typeof setTimeout>;
  /** The overall limit, progress or not. */
  overall: ReturnType<typeof setTimeout>;
  onProgress?: (p: McpProgress) => void;
}

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CALL_MS = 60 * 60_000;
/** Node fires a longer setTimeout after 1 ms, so a huge limit is held to this (about 24 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

export class McpStdioClient {
  readonly config: McpServerConfig;
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #buffer = '';
  #stderr = '';
  #closed = false;
  #closing = false;
  #exited: Promise<void> = Promise.resolve();
  /** Requests the server sent us that are still running (for notifications/cancelled). */
  readonly #serving = new Map<number | string, AbortController>();
  /** Tool calls waiting for their turn (config.concurrency), oldest first. */
  readonly #queue: { start: () => void; fail: (e: Error) => void }[] = [];
  #inFlight = 0;
  serverInfo: { name?: string; version?: string } = {};

  /** Tool calls waiting for their turn right now (for showing "waiting"). */
  get waiting(): number {
    return this.#queue.length;
  }

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  get running(): boolean {
    return !!this.#child && !this.#closed;
  }

  async connect(): Promise<void> {
    const c = this.config;
    const child = spawn(c.command, c.args ?? [], {
      cwd: c.cwd,
      // the app's proxy and certificates, so the server connects like the app; its own env wins
      env: { ...withNetworkEnv(childEnv(c.inheritEnv)), ...(c.env ?? {}) },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    this.#exited = new Promise((r) => child.once('close', () => r()));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.#onData(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      this.#stderr = (this.#stderr + d).slice(-4000);
      try {
        c.stderrLog?.(d);
      } catch {
        // a broken log sink must not break the client
      }
    });
    child.on('exit', (code) => {
      this.#fail(new Error(`MCP server "${c.name}" exited (code ${code ?? 'unknown'})${this.#stderr ? `: ${this.#stderr.trim().slice(-300)}` : ''}`));
      try {
        c.onExit?.({ code, stderrTail: this.#stderr.slice(-2000), expected: this.#closing });
      } catch {
        // ignore listener errors
      }
    });
    child.on('error', (err) => this.#fail(new Error(`could not start MCP server "${c.name}": ${err.message}`)));
    const init = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: c.onSampling ? { sampling: {} } : {},
      clientInfo: { name: 'spica', version: '0.1.0' },
    })) as { serverInfo?: { name?: string; version?: string } };
    this.serverInfo = init.serverInfo ?? {};
    this.notify('notifications/initialized', {});
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools?: McpToolInfo[]; nextCursor?: string };
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  /**
   * Call a tool. The call asks for progress: while the server keeps reporting
   * it, the call does not time out (up to maxCallMs). `onProgress` sees each report.
   */
  async callTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    onProgress?: (p: McpProgress) => void,
  ): Promise<{ content: string; isError: boolean }> {
    const done = await this.#takeTurn(signal);
    let answer: unknown;
    try {
      answer = await this.request('tools/call', { name, arguments: args ?? {} }, { ...(signal ? { signal } : {}), onProgress: onProgress ?? (() => {}) });
    } finally {
      done();
    }
    const result = answer as {
      content?: { type: string; text?: string; resource?: { text?: string; uri?: string }; mimeType?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const parts = (result.content ?? []).map((c) => {
      if (c.type === 'text') return c.text ?? '';
      if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`;
      return `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''} omitted]`;
    });
    if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
    return { content: parts.join('\n'), isError: !!result.isError };
  }

  /**
   * Wait until this tool call may run (config.concurrency), in arrival order.
   * Resolves with the function that gives the turn to the next one. A call
   * stopped while waiting leaves the queue; nothing was sent, so the server
   * is not told.
   */
  #takeTurn(signal?: AbortSignal): Promise<() => void> {
    const limit = this.config.concurrency;
    let given = false;
    const done = (): void => {
      if (given) return;
      given = true;
      this.#inFlight--;
      this.#queue.shift()?.start();
    };
    if (!limit || this.#inFlight < limit || this.#closed) {
      this.#inFlight++;
      return Promise.resolve(done);
    }
    return new Promise((resolve, reject) => {
      const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (signal?.aborted) return reject(aborted());
      const onAbort = (): void => {
        const i = this.#queue.indexOf(entry);
        if (i >= 0) this.#queue.splice(i, 1);
        reject(aborted());
      };
      const entry = {
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          this.#inFlight++;
          resolve(done);
        },
        fail: (e: Error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#queue.push(entry);
    });
  }

  /**
   * Send a request and wait for its answer. Without an answer (or, when
   * `onProgress` is given, a progress report) within timeoutMs, or after
   * maxCallMs in any case, the request fails and the server is told to stop
   * (notifications/cancelled; never for initialize, which the spec forbids).
   * An answer that arrives after that is ignored.
   */
  request(method: string, params: unknown, opts: McpRequestOptions = {}): Promise<unknown> {
    if (!this.#child || this.#closed) return Promise.reject(new Error(`MCP server "${this.config.name}" is not running`));
    const id = this.#nextId++;
    const name = this.config.name;
    const idleMs = Math.min(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMER_MS);
    const overallMs = Math.min(Math.max(this.config.maxCallMs ?? DEFAULT_MAX_CALL_MS, idleMs), MAX_TIMER_MS);
    const { signal, onProgress } = opts;
    // The token is the request id: unique among running requests, as the spec requires.
    const sent =
      onProgress && params && typeof params === 'object'
        ? { ...params, _meta: { ...((params as { _meta?: object })._meta ?? {}), progressToken: id } }
        : params;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); // never sent
      const onAbort = (): void => end(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'user interrupted');
      /** Settle once: clear both timers, forget the request, tell the server to stop when `cancel` is given. */
      const end = (err: Error | undefined, cancel?: string, value?: unknown): void => {
        const p = this.#pending.get(id);
        if (!p) return;
        clearTimeout(p.idle);
        clearTimeout(p.overall);
        this.#pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        if (cancel && method !== 'initialize') this.notify('notifications/cancelled', { requestId: id, reason: cancel });
        if (err) reject(err);
        else resolve(value);
      };
      const idle = (): ReturnType<typeof setTimeout> =>
        setTimeout(
          () =>
            end(
              new Error(`MCP server "${name}" did not answer ${method} within ${idleMs / 1000} s${onProgress ? ' and reported no progress' : ''}; it was told to stop`),
              `timed out: no answer${onProgress ? ' or progress' : ''} within ${idleMs / 1000} s`,
            ),
          idleMs,
        );
      const pending: Pending = {
        resolve: (v) => end(undefined, undefined, v),
        reject: (e) => end(e),
        idle: idle(),
        overall: setTimeout(
          () =>
            end(
              new Error(`MCP server "${name}" did not finish ${method} within ${overallMs / 1000} s (the limit for one call, progress or not); it was told to stop`),
              `timed out: the limit for one call is ${overallMs / 1000} s`,
            ),
          overallMs,
        ),
        ...(onProgress
          ? {
              onProgress: (p: McpProgress) => {
                clearTimeout(pending.idle);
                pending.idle = idle();
                try {
                  onProgress(p);
                } catch {
                  // a broken progress listener must not break the call
                }
              },
            }
          : {}),
      };
      this.#pending.set(id, pending);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: sent })}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.#child || this.#closed) return;
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /**
   * Stop the server the way the MCP stdio transport describes: close its
   * stdin, give it `graceMs` to exit on its own (so it can clean up), then
   * kill it. Resolves when the process has exited (so its files can be
   * deleted right after, which matters on Windows).
   */
  close(graceMs = 3000): Promise<void> {
    this.#closing = true;
    const child = this.#child;
    if (!this.#closed) this.#fail(new Error(`MCP server "${this.config.name}" was disconnected`));
    if (!child || child.exitCode !== null || child.signalCode !== null) return this.#exited;
    try {
      child.stdin.end();
    } catch {
      // already gone
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }, graceMs);
    return this.#exited.finally(() => clearTimeout(timer));
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let nl: number;
    while ((nl = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { code?: number; message?: string }; method?: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue; // servers sometimes print logs to stdout; ignore non-JSON lines
      }
      if (msg.id === undefined || msg.method) {
        // Server-initiated request or notification
        if (msg.method === 'notifications/cancelled') {
          const id = msg.params?.requestId as number | string | undefined;
          if (id !== undefined) this.#serving.get(id)?.abort();
        } else if (msg.method === 'notifications/progress') {
          // Only a running request that asked for progress; any other token is ignored.
          const q = msg.params ?? {};
          const p = typeof q.progressToken === 'number' ? this.#pending.get(q.progressToken) : undefined;
          if (p?.onProgress && typeof q.progress === 'number') {
            p.onProgress({
              progress: q.progress,
              ...(typeof q.total === 'number' ? { total: q.total } : {}),
              ...(typeof q.message === 'string' ? { message: q.message } : {}),
            });
          }
        } else if (msg.id !== undefined && msg.method === 'sampling/createMessage' && this.config.onSampling) {
          this.#serve(msg.id, msg.params);
        } else if (msg.id !== undefined && msg.method) {
          this.#write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported by this client' } });
        }
        continue;
      }
      const p = this.#pending.get(msg.id);
      if (!p) continue; // late: the request already timed out or was stopped
      if (msg.error) p.reject(new Error(`MCP error ${msg.error.code ?? ''}: ${msg.error.message ?? 'unknown'}`));
      else p.resolve(msg.result);
    }
  }

  #write(msg: unknown): void {
    if (!this.#child || this.#closed) return;
    try {
      this.#child.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // the server is gone
    }
  }

  /** Answer a sampling request; a refusal carries data.code (budget, rate_limited, no_model, ...). */
  #serve(id: number | string, params: unknown): void {
    const ctl = new AbortController();
    this.#serving.set(id, ctl);
    void this.config
      .onSampling!(params, ctl.signal)
      .then(
        (result) => this.#write({ jsonrpc: '2.0', id, result }),
        (err: unknown) => {
          const code = (err as { code?: unknown })?.code;
          this.#write({
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err), ...(typeof code === 'string' ? { data: { code } } : {}) },
          });
        },
      )
      .finally(() => this.#serving.delete(id));
  }

  #fail(err: Error): void {
    this.#closed = true;
    for (const [, ctl] of this.#serving) ctl.abort();
    this.#serving.clear();
    for (const p of [...this.#pending.values()]) p.reject(err); // clears its timers and forgets it
    for (const q of this.#queue.splice(0)) q.fail(err); // calls still waiting for their turn
  }
}

/** Tool name as the model sees it: `<server>__<tool>`, restricted to safe characters. */
export function mcpToolName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** Wrap an MCP server's tools as Spica tools. Destructive tools need confirmation by default. */
export function mcpTools(client: McpStdioClient, infos: McpToolInfo[], tracer: Tracer): Tool[] {
  const server = client.config.name;
  return infos.map((info) => ({
    spec: {
      name: mcpToolName(server, info.name),
      description: `[MCP ${server}] ${info.description ?? info.name}`,
      inputSchema: info.inputSchema ?? { type: 'object' },
    },
    irreversible: info.annotations?.destructiveHint === true,
    // declared read-only: a round that called it can still be regenerated
    ...(info.annotations?.readOnlyHint === true ? { readOnly: true } : {}),
    // whatever an MCP server returns comes from outside Spica (mail, external systems)
    untrusted: 'mcp',
    async execute(input, ctx) {
      const trace = tracer.start({
        kind: 'mcp',
        sessionId: ctx.sessionId || null,
        parentChain: ctx.parentChain,
        initiator: ctx.initiator ?? `tool:${mcpToolName(server, info.name)}`,
        target: server,
        ...(ctx.confirmedBy ? { confirmedBy: ctx.confirmedBy } : {}),
      });
      try {
        const r = await client.callTool(info.name, input, ctx.signal);
        trace.finish({ status: r.isError ? 'error' : 'ok', bytes: r.content.length });
        return r;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        trace.finish({ status: ctx.signal.aborted ? 'aborted' : 'error', error: message });
        return { content: ctx.signal.aborted ? 'Stopped: the user interrupted this call.' : message, isError: true };
      }
    },
  }));
}

/** Connect, list tools and register them; returns a handle that withdraws everything. */
export async function connectMcp(
  registry: ToolRegistry,
  tracer: Tracer,
  config: McpServerConfig,
  opts: { source?: string } = {},
): Promise<{ client: McpStdioClient; tools: string[]; source: string; disconnect: () => Promise<void> }> {
  const client = new McpStdioClient(config);
  try {
    await client.connect();
    const infos = await client.listTools();
    const tools = mcpTools(client, infos, tracer);
    const source = opts.source ?? `mcp:${config.name}`;
    // Keep each tool's own remover: the source may also own other tools
    // (a plugin's skills, other servers) that must survive this server.
    const removers = tools.map((t) => registry.register(t, source));
    return {
      client,
      source,
      tools: tools.map((t) => t.spec.name),
      disconnect: () => {
        for (const remove of removers) remove();
        return client.close();
      },
    };
  } catch (err) {
    await client.close();
    throw err;
  }
}
