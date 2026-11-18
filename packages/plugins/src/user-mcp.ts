// The MCP services the person adds in 设置 (not the ones plugins bring): each a program on this computer, started
// while its switch is on and kept going by the same supervisor as plugin servers (supervisor.ts). Its tools come in
// under the source `mcp:<name>`. Approval 'ask' (the default): every one of its tools asks before it runs, in any
// approval mode (a hook's confirm, the card the app already has); 'auto': as other tools (a tool the server marks
// destructive still asks by default). The host keeps the list, secrets sealed, and hands it over in the clear.
// npx and uvx services start offline first and download only once the person agreed (runner.ts).
import { homedir } from 'node:os';
import { findCommand } from '@spica/core';
import { hasBundledPython, missedDownload, packageOf, runnerLaunch, runnerOf, type BundledUv, type DownloadNeed } from './runner.ts';
import type { McpLaunch, PluginHost } from './host.ts';
import { scrubSecrets } from './user-config.ts';
import { mcpProblem, type McpProblem } from './mcp-problem.ts';
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

/** How a service is doing: a server's status, 'off' (switched off), and while npx or uvx would download first, 'needs-download' (waiting for the person) and 'downloading'. */
export type UserMcpStatus = ServerStatus | 'off' | 'needs-download' | 'downloading';

/** How it is doing, for the settings page. */
export interface UserMcpState {
  name: string;
  status: UserMcpStatus;
  /** Its tools as the model sees them (`<name>__<tool>`). */
  tools: string[];
  lastError?: string;
  /** The last lines it wrote to its error output (newest last). */
  logTail: string[];
  /** The MCP version it speaks, once running. */
  protocolVersion?: string;
  /** 'needs-download': what would be downloaded. */
  download?: DownloadNeed;
  /** 'failed': why, as a kind the page words in the interface language. */
  problem?: McpProblem;
}

export type UserMcpEvent = { type: 'user-mcp.status'; name: string; status: UserMcpStatus; message?: string } | { type: 'user-mcp.error'; name: string; message: string };

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
  /** The app's own uv: uvx runs as it when the computer has no uvx. */
  uv?: BundledUv;
  /** How long a service may take to download itself and answer, once allowed. Default 30 min. */
  downloadTimeoutMs?: number;
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
  /** npx or uvx: the package is not here ('needed', waiting for the person) or may be downloaded ('allowed'). */
  download?: 'needed' | 'allowed';
  /** Left stopped after crashing again and again (how many times, in how many seconds). */
  crashLoop?: { count: number; seconds: number };
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
      const need = run.download === 'needed' ? this.#need(run) : undefined;
      return {
        name: c.name,
        status: this.#status(run, run.status),
        ...(need ? { download: need } : {}),
        tools: run.handle?.tools ?? [],
        ...(run.lastError ? { lastError: this.#scrub(run, run.lastError) } : {}),
        ...(run.status === 'failed' && run.download !== 'needed' ? { problem: run.crashLoop ? { kind: 'crash-loop' as const, ...run.crashLoop } : mcpProblem(run.lastError ?? '', run.log, run.config.command) } : {}),
        logTail: [...run.log],
        ...(run.handle?.protocolVersion ? { protocolVersion: run.handle.protocolVersion } : {}),
      };
    });
  }

  /**
   * The person agreed to the download a 'needs-download' service is waiting for: it starts with downloads allowed
   * ('downloading' until it answers). Resolves when that start is over.
   */
  download(name: string): Promise<void> {
    return this.#serial(async () => {
      const run = this.#runs.get(name);
      if (!run || run.download !== 'needed') return;
      run.download = 'allowed';
      run.restarts = [];
      await this.#start(run);
    });
  }

  /** The status shown: a start held by a missing package or a download under way says so. */
  #status(run: Running, status: ServerStatus): UserMcpStatus {
    if (run.download === 'needed' && status === 'failed') return 'needs-download';
    if (run.download === 'allowed' && (status === 'starting' || status === 'restarting')) return 'downloading';
    return status;
  }

  #need(run: Running): DownloadNeed | undefined {
    const runner = runnerOf(run.config.command);
    if (!runner) return undefined;
    const bundled = runner === 'uvx' && !this.#uvOnPath(run) && this.#o.uv;
    return { runner, package: packageOf(runner, run.config.args), python: bundled ? !hasBundledPython(bundled) : false };
  }

  #uvOnPath(run: Running): boolean {
    return findCommand('uvx', { ...process.env, ...run.config.env }, run.config.cwd) !== undefined;
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
    delete run.crashLoop;
    try {
      await startServer(run, this.#supervision(run));
      if (run.download === 'allowed') delete run.download;
    } catch (err) {
      const runner = runnerOf(run.config.command);
      if (runner && run.download !== 'allowed' && missedDownload(runner, `${run.lastError ?? ''}\n${run.log.join('\n')}`)) {
        // the package is not here: nothing is fetched until the person agrees
        run.download = 'needed';
        this.#emit({ type: 'user-mcp.status', name: run.config.name, status: 'needs-download' });
        return;
      }
      if (run.download === 'allowed') delete run.download;
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
    const runner = runnerOf(c.command);
    const download = run.download === 'allowed';
    const how = runner
      ? runnerLaunch(runner, c.command, c.args, c.env, { download, ...(this.#o.uv ? { uv: this.#o.uv } : {}), uvOnPath: runner === 'uvx' && this.#uvOnPath(run) })
      : { command: c.command, args: [...c.args], env: { ...c.env } };
    return {
      name: c.name,
      command: how.command,
      args: how.args,
      env: how.env,
      ...(download ? { startTimeoutMs: this.#o.downloadTimeoutMs ?? 30 * 60_000 } : {}),
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
        this.#emit({ type: 'user-mcp.status', name, status: this.#status(run, status), ...(message ? { message: this.#scrub(run, message) } : {}) });
      },
      log: (line) => this.#log(run, `[spica] ${line}`),
      alive: () => this.#runs.get(name) === run,
      serial: (fn) => this.#serial(fn),
      gaveUp: (message) => this.#emit({ type: 'user-mcp.error', name, message: `「${name}」${this.#scrub(run, message)}` }),
      crashMessage: (count, windowS) => {
        run.crashLoop = { count, seconds: windowS };
        return `${windowS} 秒内崩溃 ${count} 次，已停止重启。`;
      },
      startError: (message, cause) => new Error(`「${name}」启动失败：${message}`, { cause }),
    };
  }
}
