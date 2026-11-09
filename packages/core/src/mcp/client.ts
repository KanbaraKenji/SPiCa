// Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0):
// initialize → notifications/initialized → tools/list → tools/call.
// External tools are added to the tool registry under source `mcp:<name>`.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Tracer } from '../trace.ts';
import type { Tool, ToolRegistry } from '../tools/types.ts';
import { childEnv } from '../util.ts';

export interface McpServerConfig {
  /** Short name; tools appear as `<name>__<tool>`. */
  name: string;
  command: string;
  args?: string[];
  /** Extra variables for the server (passed as given). */
  env?: Record<string, string>;
  /**
   * Which host variables the server inherits: a whitelist (default: PATH,
   * SystemRoot, TEMP/TMP, USERPROFILE, APPDATA, LOCALAPPDATA, proxy variables,
   * ...) or 'all'. Secret-looking names (model keys, tokens) never pass.
   */
  inheritEnv?: 'all' | string[];
  cwd?: string;
  /** Per-request timeout. Default 60 s. */
  timeoutMs?: number;
  /**
   * Called once when the server process ends. `expected` is true when it was
   * stopped by disconnect()/close(); otherwise it crashed or quit by itself.
   */
  onExit?(info: { code: number | null; stderrTail: string; expected: boolean }): void;
  /** Receives the server's stderr as it arrives (e.g. to write a plugin log). */
  stderrLog?(chunk: string): void;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PROTOCOL_VERSION = '2025-06-18';

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
  serverInfo: { name?: string; version?: string } = {};

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
      env: childEnv(c.inheritEnv, c.env),
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
      capabilities: {},
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

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<{ content: string; isError: boolean }> {
    const result = (await this.request('tools/call', { name, arguments: args ?? {} }, signal)) as {
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

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.#child || this.#closed) return Promise.reject(new Error(`MCP server "${this.config.name}" is not running`));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP server "${this.config.name}" did not answer ${method} within ${(this.config.timeoutMs ?? 60_000) / 1000} s`));
      }, this.config.timeoutMs ?? 60_000);
      this.#pending.set(id, { resolve, reject, timer });
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.#pending.has(id)) return;
          clearTimeout(timer);
          this.#pending.delete(id);
          this.notify('notifications/cancelled', { requestId: id, reason: 'user interrupted' });
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        },
        { once: true },
      );
      this.#child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.#child || this.#closed) return;
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /**
   * Stop the server. Resolves when the process has exited (so its files can
   * be deleted right after, which matters on Windows).
   */
  close(): Promise<void> {
    this.#closing = true;
    const child = this.#child;
    if (!this.#closed) this.#fail(new Error(`MCP server "${this.config.name}" was disconnected`));
    if (!child || child.exitCode !== null || child.signalCode !== null) return this.#exited;
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // already gone
    }
    return this.#exited;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let nl: number;
    while ((nl = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { code?: number; message?: string }; method?: string };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue; // servers sometimes print logs to stdout; ignore non-JSON lines
      }
      if (msg.id === undefined || msg.method) {
        // Server-initiated request or notification: answer requests we do not support.
        if (msg.id !== undefined && msg.method) {
          this.#child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported by this client' } })}\n`);
        }
        continue;
      }
      const p = this.#pending.get(msg.id);
      if (!p) continue;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`MCP error ${msg.error.code ?? ''}: ${msg.error.message ?? 'unknown'}`));
      else p.resolve(msg.result);
    }
  }

  #fail(err: Error): void {
    this.#closed = true;
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
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
    async execute(input, ctx) {
      const trace = tracer.start({
        kind: 'mcp',
        sessionId: ctx.sessionId,
        parentChain: ctx.parentChain,
        initiator: `tool:${mcpToolName(server, info.name)}`,
        target: server,
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
