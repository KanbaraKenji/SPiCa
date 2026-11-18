// The MCP services the person adds in 设置 (not the ones plugins bring): each a program on this computer, started
// while its switch is on and kept going by the same supervisor as plugin servers (supervisor.ts). Its tools come in
// under the source `mcp:<name>`. Approval 'ask' (the default): every one of its tools asks before it runs, in any
// approval mode (a hook's confirm, the card the app already has); 'auto': as other tools (a tool the server marks
// destructive still asks by default). The host keeps the list, secrets sealed, and hands it over in the clear.
import { homedir } from 'node:os';
import type { McpLaunch, PluginHost } from './host.ts';
import { scrubSecrets } from './user-config.ts';
import { newRun, startServer, stopServer, type ServerStatus, type SupervisedRun, type Supervision } from './supervisor.ts';

export type UserMcpApproval = 'ask' | 'auto';

/** One service as the host stores it (environment values in the clear). */
export interface UserMcpConfig {
  /** Letters, digits, _ and -: its tools are `<name>__<tool>`. */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  approval: UserMcpApproval;
}

/** How it is doing, for the settings page. */
export interface UserMcpState {
  name: string;
  status: ServerStatus | 'off';
  /** Its tools as the model sees them (`<name>__<tool>`). */
  tools: string[];
  lastError?: string;
  /** The last lines it wrote to its error output (newest last). */
  logTail: string[];
  /** The MCP version it speaks, once running. */
  protocolVersion?: string;
}

export type UserMcpEvent = { type: 'user-mcp.status'; name: string; status: ServerStatus | 'off'; message?: string } | { type: 'user-mcp.error'; name: string; message: string };

export interface UserMcpOptions {
  host: Pick<PluginHost, 'connectMcp' | 'registerHooks' | 'addRedactions'>;
  /** Host variables a service may inherit (whitelist); secret-looking names never pass. */
  inheritEnv?: string[];
  /** Stopping a service also ends what it started (Windows). Default true. */
  endTree?: boolean;
  /** Crashes allowed in the window before it is left stopped. Default 3 in 60 s, as a plugin's. */
  restart?: { maxRestarts: number; windowMs: number };
  /** Where a service without 工作文件夹 runs. Default: the user's home folder. */
  defaultCwd?: string;
  /** Lines kept of its error output. Default 20. */
  logLines?: number;
  onEvent?(e: UserMcpEvent): void;
  /** Each line it writes to its error output, and our own about it. */
  onLog?(name: string, line: string): void;
}

interface Running extends SupervisedRun {
  config: UserMcpConfig;
  log: string[];
  /** Withdraws its approval hook. */
  unhook?: () => void;
  /**
   * Speak only the handshake to it: it quit when asked server/discover, or it answered the handshake last time
   * (the spec lets a client remember that across restarts), so a restart does not wait for the probe again.
   */
  legacy?: boolean;
}

/** The version without a handshake (MCP 2026-07-28), as the core reports it. */
const MODERN = '2026-07-28';

const same = (a: UserMcpConfig, b: UserMcpConfig): boolean => JSON.stringify({ ...a, approval: '' }) === JSON.stringify({ ...b, approval: '' });

export class UserMcpServers {
  readonly #o: UserMcpOptions;
  readonly #runs = new Map<string, Running>();
  #configs: UserMcpConfig[] = [];
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: UserMcpOptions) {
    this.#o = options;
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * The list as it is now: services gone or switched off stop, new or switched on ones start, changed ones
   * restart (a change of approval alone takes effect at once). Resolves when every start has been tried; a
   * service that cannot start is 'failed' with its reason, the others go on.
   */
  set(configs: readonly UserMcpConfig[]): Promise<void> {
    return this.#serial(async () => {
      this.#configs = configs.map((c) => ({ ...c, args: [...c.args], env: { ...c.env } }));
      // its variables' values are secrets: never in what the core shows or stores
      this.#o.host.addRedactions?.(this.#configs.flatMap((c) => Object.values(c.env)).filter((v) => v.length >= 6));
      const wanted = new Map(this.#configs.filter((c) => c.enabled).map((c) => [c.name, c]));
      for (const [name, run] of [...this.#runs]) {
        const next = wanted.get(name);
        if (next && same(next, run.config)) {
          run.config = next; // approval read from here by its hook
          continue;
        }
        await this.#stop(run);
        this.#runs.delete(name);
        if (!next) this.#emit({ type: 'user-mcp.status', name, status: 'off' });
      }
      for (const [name, config] of wanted) {
        if (this.#runs.has(name)) continue;
        const run: Running = { ...newRun(), config, log: [] };
        this.#runs.set(name, run);
        run.unhook = this.#hook(run);
        await this.#start(run);
      }
    });
  }

  /** Every service in the list, in its order, with how it is doing. */
  states(): UserMcpState[] {
    return this.#configs.map((c) => {
      const run = c.enabled ? this.#runs.get(c.name) : undefined;
      if (!run) return { name: c.name, status: 'off', tools: [], logTail: [] };
      return {
        name: c.name,
        status: run.status,
        tools: run.handle?.tools ?? [],
        ...(run.lastError ? { lastError: this.#scrub(run, run.lastError) } : {}),
        logTail: [...run.log],
        ...(run.handle?.protocolVersion ? { protocolVersion: run.handle.protocolVersion } : {}),
      };
    });
  }

  /** Start every running service again (the network settings changed: they read them at start). */
  restartAll(): Promise<void> {
    return this.#serial(async () => {
      for (const run of this.#runs.values()) {
        await stopServer(run, this.#supervision(run));
        run.restarts = [];
        await this.#start(run);
      }
    });
  }

  /** Stop them all (the app is closing). */
  close(): Promise<void> {
    return this.#serial(async () => {
      for (const run of [...this.#runs.values()].reverse()) await this.#stop(run);
      this.#runs.clear();
    });
  }

  /** Start it; one that quit on the version probe is started once more with the handshake only. Never throws. */
  async #start(run: Running): Promise<void> {
    try {
      await startServer(run, this.#supervision(run));
    } catch (err) {
      if (run.legacy || !(err as { cause?: { diedOnProbe?: boolean } }).cause?.diedOnProbe) return;
      run.legacy = true;
      this.#log(run, '[spica] quit when asked server/discover: starting again with initialize');
      await startServer(run, this.#supervision(run)).catch(() => undefined);
    }
  }

  async #stop(run: Running): Promise<void> {
    run.unhook?.();
    delete run.unhook;
    await stopServer(run, this.#supervision(run));
  }

  #emit(e: UserMcpEvent): void {
    try {
      this.#o.onEvent?.(e);
    } catch {
      // a listener must not break the services
    }
  }

  /** Its variables' values taken out of a line it wrote or an error about it. */
  #scrub(run: Running, text: string): string {
    return scrubSecrets(text, Object.values(run.config.env));
  }

  #log(run: Running, raw: string): void {
    const line = this.#scrub(run, raw);
    const keep = this.#o.logLines ?? 20;
    for (const l of line.split(/\r?\n/)) {
      if (!l.trim()) continue;
      run.log.push(l);
      if (run.log.length > keep) run.log.splice(0, run.log.length - keep);
    }
    try {
      this.#o.onLog?.(run.config.name, line);
    } catch {
      // a broken log sink must not break the service
    }
  }

  /** 每次询问: each of its tools asks first, whatever the approval mode. */
  #hook(run: Running): () => void {
    const prefix = `${run.config.name}__`;
    return this.#o.host.registerHooks(
      `mcp:${run.config.name}`,
      {
        beforeTool: (call) => {
          if (!call.name.startsWith(prefix) || run.config.approval !== 'ask') return;
          return { action: 'confirm', reason: `「${run.config.name}」：${call.name.slice(prefix.length)}` };
        },
      },
      { priority: 10 },
    );
  }

  #launch(run: Running): Omit<McpLaunch, 'onExit'> {
    const c = run.config;
    return {
      name: c.name,
      command: c.command,
      args: [...c.args],
      env: { ...c.env },
      ...(this.#o.inheritEnv ? { inheritEnv: this.#o.inheritEnv } : {}),
      // none given: the user's home folder (not the app's own folder)
      cwd: c.cwd || this.#o.defaultCwd || homedir(),
      endTree: this.#o.endTree ?? true,
      // a service someone else wrote may speak the 2026-07-28 version: asked first, the handshake otherwise
      protocol: run.legacy ? 'legacy' : 'auto',
      stderrLog: (chunk) => this.#log(run, chunk.trimEnd()),
    };
  }

  #supervision(run: Running): Supervision {
    const name = run.config.name;
    return {
      host: this.#o.host,
      source: `mcp:${name}`,
      launch: (onExit) => ({ ...this.#launch(run), onExit }) as McpLaunch,
      restart: this.#o.restart ?? { maxRestarts: 3, windowMs: 60_000 },
      setStatus: (status, message) => {
        // it answered: remember which way (a restart need not probe again)
        if (status === 'running' && run.handle) run.legacy = run.handle.protocolVersion !== MODERN;
        this.#emit({ type: 'user-mcp.status', name, status, ...(message ? { message: this.#scrub(run, message) } : {}) });
      },
      log: (line) => this.#log(run, `[spica] ${line}`),
      alive: () => this.#runs.get(name) === run,
      serial: (fn) => this.#serial(fn),
      gaveUp: (message) => this.#emit({ type: 'user-mcp.error', name, message: `「${name}」${this.#scrub(run, message)}` }),
      crashMessage: (count, windowS) => `${windowS} 秒内崩溃 ${count} 次，已停止重启。`,
      startError: (message, cause) => new Error(`「${name}」启动失败：${message}`, { cause }),
    };
  }
}
