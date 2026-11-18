// Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0):
// initialize → notifications/initialized → tools/list → tools/call; with protocol 'auto', server/discover first
// (MCP 2026-07-28: no handshake, each request carries the version in _meta) and initialize only when the server
// does not know it. On Windows a .cmd or .bat (the npx and uvx shims) is started through cmd.exe (win-command.ts).
// Tool calls ask for progress (MCP 2025-06-18 progress utility): a report
// restarts the wait, up to an overall limit; a call that times out or is
// stopped is cancelled at the server (notifications/cancelled).
// External tools are added to the tool registry under source `mcp:<name>`.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Tracer } from '../trace.ts';
import type { Tool, ToolRegistry } from '../tools/types.ts';
import { withNetworkEnv } from '../net.ts';
import type { SamplingGrant } from '../sampling.ts';
import { producedFileCard } from '../tools/file-card.ts';
import type { ImageBlock } from '../types.ts';
import { keepMedia, type KeptMedia } from './media.ts';
import { childEnv } from '../util.ts';
import { descendants, endTree, listProcesses } from './process-tree.ts';
import { windowsLaunch } from './win-command.ts';

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
   * Which MCP version to speak. 'legacy' (default): the initialize handshake (2025-06-18). 'auto': ask first with
   * server/discover in the 2026-07-28 way and keep to it when the server knows it; any other answer, or none
   * within discoverTimeoutMs, and the client falls back to initialize (the spec's stdio backward compatibility).
   */
  protocol?: 'legacy' | 'auto';
  /** How long 'auto' waits for the answer to server/discover before it takes the server for an older one. Default 5 s. */
  discoverTimeoutMs?: number;
  /**
   * How long the first answer (initialize or server/discover) may take, instead of timeoutMs: a program that
   * downloads itself first (npx, uvx the first time) answers only once that is done.
   */
  startTimeoutMs?: number;
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
   * Stopping the server also ends the processes it started and theirs
   * (Windows; see process-tree.ts): what is still running when the grace time
   * is over is ended. A program started through a launcher that has exited is
   * not in the tree. Set for plugin servers. Default false.
   */
  endTree?: boolean;
  /** How long close() waits for the process list before stopping the server anyway. Default 3 s. */
  endTreeWaitMs?: number;
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
  /** Display name for people (MCP 2025-06-18; older servers put it in annotations.title). */
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean; title?: string };
}

/** One notifications/progress from the server for a running call. */
export interface McpProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface McpRequestOptions {
  signal?: AbortSignal;
  /** This request's own wait for an answer (instead of config.timeoutMs). */
  timeoutMs?: number;
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
/** The version without a handshake (MCP 2026-07-28). */
export const MODERN_PROTOCOL = '2026-07-28';
const DEFAULT_DISCOVER_MS = 5_000;
const CLIENT_INFO = { name: 'spica', version: '0.1.0' };

type InitResult = { protocolVersion?: string; serverInfo?: { name?: string; version?: string } } | undefined;

/** An MCP error answer, its JSON-RPC code and data kept. */
export class McpRpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  constructor(code: number | undefined, message: string, data?: unknown) {
    super(`MCP error ${code ?? ''}: ${message}`);
    this.code = code;
    this.data = data;
  }
}
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
  /** Set by the first close(): resolves when the server and, with endTree, its tree are gone. */
  #stopped: Promise<void> | undefined;
  #startedAt = 0;
  /** Requests the server sent us that are still running (for notifications/cancelled). */
  readonly #serving = new Map<number | string, AbortController>();
  /** Tool calls waiting for their turn (config.concurrency), oldest first. */
  readonly #queue: { start: () => void; fail: (e: Error) => void }[] = [];
  #inFlight = 0;
  serverInfo: { name?: string; version?: string } = {};
  /** The version in use once connected: MODERN_PROTOCOL, or the one the handshake agreed. */
  protocolVersion: string | undefined;

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

  /** The server's process id, once started. */
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  async connect(): Promise<void> {
    const c = this.config;
    // the app's proxy and certificates, so the server connects like the app; its own env wins
    const env = { ...withNetworkEnv(childEnv(c.inheritEnv)), ...(c.env ?? {}) };
    const launch = windowsLaunch(c.command, c.args ?? [], env, c.cwd);
    const child = spawn(launch.command, launch.args, {
      cwd: c.cwd,
      env,
      windowsHide: true,
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    this.#startedAt = Date.now();
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
    if (c.protocol === 'auto') return this.#probe();
    this.#settle(await this.#initialize());
  }

  #initialize(): Promise<InitResult> {
    const wait = this.config.startTimeoutMs;
    return this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: this.#capabilities(), clientInfo: CLIENT_INFO }, wait ? { timeoutMs: wait } : {}) as Promise<InitResult>;
  }

  /** The handshake answered: its version and server, then notifications/initialized. */
  #settle(init: InitResult): void {
    this.serverInfo = init?.serverInfo ?? {};
    this.protocolVersion = typeof init?.protocolVersion === 'string' ? init.protocolVersion : PROTOCOL_VERSION;
    this.notify('notifications/initialized', {});
  }

  #capabilities(): Record<string, unknown> {
    return this.config.onSampling ? { sampling: {} } : {};
  }

  /** What every request carries in _meta in MODERN_PROTOCOL. */
  #modernMeta(): Record<string, unknown> {
    return {
      'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
      'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
      'io.modelcontextprotocol/clientCapabilities': this.#capabilities(),
    };
  }

  /**
   * protocol 'auto' (MCP 2026-07-28, stdio backward compatibility): server/discover first. A server that offers
   * MODERN_PROTOCOL is spoken to that way, no handshake. Any other error means an older server: initialize. No
   * answer within discoverTimeoutMs: initialize is sent too, the discover still waited for (a program that is slow
   * to start, a first npx or uvx run, answers late), and whichever succeeds first decides. A newer server without
   * MODERN_PROTOCOL is an error: the spec says not to fall back then. A server that quits before answering at all
   * fails with `diedOnProbe` set, so its owner can start it again with the handshake only.
   */
  #probe(): Promise<void> {
    const c = this.config;
    const versionsError = (list: string): Error => new Error(`MCP server "${c.name}" supports only ${list}; Spica speaks ${MODERN_PROTOCOL} and ${PROTOCOL_VERSION}`);
    return new Promise<void>((resolve, reject) => {
      let done = false;
      let discover: 'pending' | 'older' = 'pending';
      let init: 'none' | 'pending' | Error = 'none';
      let answered = false;
      const finish = (f: () => void): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        f();
      };
      const fail = (err: unknown): void =>
        finish(() => reject(!answered && !this.running ? Object.assign(err instanceof Error ? err : new Error(String(err)), { diedOnProbe: true }) : err));
      const startInit = (): void => {
        if (init !== 'none') return;
        init = 'pending';
        this.#initialize().then(
          (r) => finish(() => {
            this.#settle(r);
            resolve();
          }),
          (err: Error) => {
            init = err;
            // the discover may still answer (a newer server refuses initialize)
            if (discover !== 'pending' || !this.running) fail(err);
          },
        );
      };
      const timer = setTimeout(startInit, c.discoverTimeoutMs ?? DEFAULT_DISCOVER_MS);
      this.request('server/discover', { _meta: this.#modernMeta() }, c.startTimeoutMs ? { timeoutMs: c.startTimeoutMs } : {}).then(
        (raw) => {
          answered = true;
          const r = raw as { supportedVersions?: unknown; _meta?: Record<string, unknown> } | undefined;
          const versions = Array.isArray(r?.supportedVersions) ? r.supportedVersions.filter((v): v is string => typeof v === 'string') : [];
          if (versions.includes(MODERN_PROTOCOL)) {
            return finish(() => {
              this.protocolVersion = MODERN_PROTOCOL;
              const info = r?._meta?.['io.modelcontextprotocol/serverInfo'];
              this.serverInfo = info && typeof info === 'object' ? (info as { name?: string; version?: string }) : {};
              resolve();
            });
          }
          if (versions.length > 0) return fail(versionsError(versions.join(', ')));
          // an answer that names no versions is not a newer server: taken for an older one
          older();
        },
        (err: unknown) => {
          if (err instanceof McpRpcError) answered = true;
          if (err instanceof McpRpcError && err.code === -32022) {
            const supported = (err.data as { supported?: unknown } | undefined)?.supported;
            return fail(Object.assign(versionsError(Array.isArray(supported) ? supported.join(', ') : 'other versions'), { cause: err }));
          }
          if (!this.running) return fail(err);
          older();
        },
      );
      const older = (): void => {
        discover = 'older';
        if (init === 'none') startInit();
        else if (init instanceof Error) fail(init);
      };
    });
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
    /** Keeps an image or audio item as a file (the conversation's media folder); without it they are left out. */
    keep?: (kind: 'image' | 'audio', data: string, mimeType: string) => KeptMedia | undefined,
  ): Promise<{ content: string; isError: boolean; files?: string[]; images?: ImageBlock[] }> {
    const done = await this.#takeTurn(signal);
    let answer: unknown;
    try {
      answer = await this.request('tools/call', { name, arguments: args ?? {} }, { ...(signal ? { signal } : {}), onProgress: onProgress ?? (() => {}) });
    } finally {
      done();
    }
    if ((answer as { resultType?: unknown } | undefined)?.resultType === 'input_required') {
      // MCP 2026-07-28: the server needs something (a form for the person, a model's answer) before it can go on;
      // Spica does not answer those yet
      const asks = Object.values((answer as { inputRequests?: Record<string, { method?: string }> }).inputRequests ?? {}).map((q) => q?.method ?? '?');
      return { content: `The MCP server asked for more input before it can finish (${asks.join(', ') || 'input_required'}); Spica cannot answer that yet.`, isError: true };
    }
    const result = answer as {
      content?: { type: string; text?: string; uri?: string; data?: string; resource?: { text?: string; uri?: string }; mimeType?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const files: string[] = [];
    const images: ImageBlock[] = [];
    const parts = (result.content ?? []).map((c) => {
      if (c.type === 'text') return c.text ?? '';
      if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`;
      if (c.type === 'resource_link') {
        const link = linkLine(c.uri);
        if (link.file) files.push(link.file);
        return link.line;
      }
      if ((c.type === 'image' || c.type === 'audio') && keep && typeof c.data === 'string') {
        const kept = keep(c.type, c.data, c.mimeType ?? '');
        if (kept) {
          files.push(kept.path);
          if (kept.image) images.push(kept.image);
          if (c.type === 'audio') return `音频：${kept.path}（模型听不到内容）`;
          return kept.image ? `图片：${kept.path}` : `图片：${kept.path}（格式或大小不合适，没有发给模型）`;
        }
      }
      return `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''} omitted]`;
    });
    // structuredContent: the spec asks servers to repeat it as JSON text, and servers that wrap a
    // non-object result ({ value }) say it differently there; so it is given only when nothing else is
    if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
    return { content: parts.join('\n'), isError: !!result.isError, ...(files.length > 0 ? { files } : {}), ...(images.length > 0 ? { images } : {}) };
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
    const idleMs = Math.min(opts.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMER_MS);
    const overallMs = Math.min(Math.max(this.config.maxCallMs ?? DEFAULT_MAX_CALL_MS, idleMs), MAX_TIMER_MS);
    const { signal, onProgress } = opts;
    // The token is the request id: unique among running requests, as the spec requires.
    let sent =
      onProgress && params && typeof params === 'object'
        ? { ...params, _meta: { ...((params as { _meta?: object })._meta ?? {}), progressToken: id } }
        : params;
    // MODERN_PROTOCOL: every request says the version, who asks and what it can do
    if (this.protocolVersion === MODERN_PROTOCOL) {
      const p = sent && typeof sent === 'object' ? (sent as { _meta?: object }) : {};
      sent = { ...p, _meta: { ...this.#modernMeta(), ...(p._meta ?? {}) } };
    }
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
        // never for initialize (the spec forbids it), nor for the server/discover probe (an older server never knew it)
        if (cancel && method !== 'initialize' && method !== 'server/discover') this.notify('notifications/cancelled', { requestId: id, reason: cancel });
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
   * deleted right after, which matters on Windows). With endTree, also when
   * the processes it started are gone: what is still running at the end of
   * the grace time is ended.
   */
  close(graceMs = 3000): Promise<void> {
    this.#closing = true;
    const child = this.#child;
    if (!this.#closed) this.#fail(new Error(`MCP server "${this.config.name}" was disconnected`));
    // a server that has already ended (crashed) is not looked into: its restart must not wait
    if (!child || child.exitCode !== null || child.signalCode !== null) return this.#stopped ?? this.#exited;
    if (this.#stopped) return this.#stopped;
    // With endTree, list what the server started before telling it to stop:
    // once it exits, the children Node tied to it end too, and their own
    // children would no longer be traceable to it. The grace time starts after.
    // A list taken for another server a moment ago serves (stops in a row).
    const listMs = Math.max(10_000, this.config.endTreeWaitMs ?? 0);
    const tree =
      this.config.endTree && child.pid !== undefined
        ? listProcesses({ notBefore: this.#startedAt, timeoutMs: listMs }).then(({ procs, error }) => {
            if (error) this.#log(`[spica] could not list the processes this server started (${error}); only the server is stopped`);
            return descendants(procs, child.pid!, this.#startedAt);
          })
        : Promise.resolve([]);
    let deadline = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      deadline = Date.now() + graceMs;
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.stdin.end();
      } catch {
        // already gone
      }
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }, graceMs);
    };
    // Wait for the list at most endTreeWaitMs before stopping the server (the app gives the core only a few
    // seconds to close). A list that comes later still finds what the server started directly, though not
    // what those started.
    const waitForList = new Promise<void>((r) => setTimeout(r, this.config.endTreeWaitMs ?? 3_000));
    this.#stopped = Promise.race([tree, waitForList])
      .then(() => {
        stop();
        // once the server is gone, what it started gets 1 s more to wind up (not the whole grace)
        return this.#exited
          .finally(() => clearTimeout(timer))
          .then(() => {
            const windUp = Date.now() + 1_000;
            const log = (line: string): void => this.#log(line);
            return tree.then((t) => endTree(t, Math.min(deadline, windUp), { timeoutMs: listMs, log }));
          });
      })
      .then(
        () => undefined,
        () => undefined,
      );
    return this.#stopped;
  }

  /** A line of our own in the server's log (the plugin log). */
  #log(line: string): void {
    try {
      this.config.stderrLog?.(`${line}\n`);
    } catch {
      // a broken log sink must not break the client
    }
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
      if (msg.error) p.reject(new McpRpcError(msg.error.code, msg.error.message ?? 'unknown', (msg.error as { data?: unknown }).data));
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

/**
 * What the model reads for a resource_link (MCP 2025-06-18), and the local file
 * it names, if any: only a file:// URI of an existing file is a file. The spec
 * allows file:// URIs that are not on disk; those, folders, missing files and
 * other schemes are said as they are.
 */
export function linkLine(uri: unknown): { line: string; file?: string } {
  const u = typeof uri === 'string' ? uri : '';
  if (!/^file:/i.test(u)) return { line: `链接：${u}` };
  let path: string;
  try {
    path = fileURLToPath(u);
  } catch {
    return { line: `链接：${u}` };
  }
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info) return { line: `文件（不存在）：${path}` };
  if (info.isDirectory()) return { line: `文件夹：${path}` };
  if (!info.isFile()) return { line: `链接：${u}` };
  return { line: `文件：${path}`, file: path };
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
    ...(info.title || info.annotations?.title ? { title: info.title || info.annotations!.title! } : {}),
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
        // images and audio are kept in the conversation's media folder (a plugin page's call has none: left out)
        const dir = ctx.mediaDir;
        const keep = dir ? (kind: 'image' | 'audio', data: string, type: string) => keepMedia(dir, kind, data, type) : undefined;
        const r = await client.callTool(info.name, input, ctx.signal, undefined, keep);
        trace.finish({ status: r.isError ? 'error' : 'ok', bytes: r.content.length });
        // files the tool made (resource_link to a local file, kept images and audio): one card each, in order
        const cards = (await Promise.all((r.files ?? []).map((f) => producedFileCard(f, 'produced')))).filter((c) => c !== undefined);
        if (cards.length > 0) ctx.emit({ type: 'file.card', callId: ctx.callId, file: cards[0]!, files: cards });
        return { content: r.content, isError: r.isError, ...(r.images ? { images: r.images } : {}) };
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
    const source = opts.source ?? `mcp:${config.name}`;
    // a service the person added (source mcp:<name>, not a plugin's): the window names it as they wrote it
    const tools = mcpTools(client, infos, tracer).map((t) => (source === `mcp:${config.name}` ? { ...t, server: config.name } : t));
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
