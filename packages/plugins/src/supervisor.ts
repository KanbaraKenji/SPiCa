// Keeping one MCP server process going, for a plugin's servers and for the services the person adds in 设置
// alike: start it (its tools come in under a source), stop it (they go, and the call resolves once the process has
// exited), and when it crashes, start it again after 0.25 s, 0.5 s, 1 s… up to a number of times in a window,
// then give up and say so. The owner says how to launch it, where its status goes and what its messages read.
import type { McpExit, McpHandle, McpLaunch, PluginHost } from './host.ts';

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';

/** One server's state, kept by its owner. */
export interface SupervisedRun {
  status: ServerStatus;
  handle?: McpHandle;
  /** When it crashed and was started again, within the window. */
  restarts: number[];
  /** Being stopped on purpose: its exit is not a crash. */
  stopping: boolean;
  lastError?: string;
}

export interface Supervision {
  host: Pick<PluginHost, 'connectMcp'>;
  /** Its tools are registered under this source. */
  source: string;
  /** How to start it now (read at every start: settings may have changed); `onExit` is the supervisor's. */
  launch(onExit: (info: McpExit) => void): McpLaunch;
  restart: { maxRestarts: number; windowMs: number };
  setStatus(status: ServerStatus, message?: string): void;
  /** A line for its log. */
  log(line: string): void;
  /** Still wanted (its owner has not dropped it): a restart is not started otherwise. */
  alive(): boolean;
  /** Runs a start after the starts and stops already asked for. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
  /** It crashed too often and is left stopped; `message` is lastError. */
  gaveUp(message: string): void;
  /** What lastError says when it crashed `count` times within `windowS` seconds. */
  crashMessage(count: number, windowS: number): string;
  /** The error start() throws (its message is lastError). */
  startError(message: string, cause: unknown): Error;
  /** Runs before each start (a data folder to make). */
  beforeStart?(): Promise<void>;
}

export function newRun(): SupervisedRun {
  return { status: 'stopped', restarts: [], stopping: false };
}

function set(run: SupervisedRun, s: Supervision, status: ServerStatus, message?: string): void {
  run.status = status;
  s.setStatus(status, message);
}

/** Start it; on failure it is 'failed' with lastError and the owner's error is thrown. */
export async function startServer(run: SupervisedRun, s: Supervision): Promise<void> {
  run.stopping = false;
  set(run, s, run.restarts.length > 0 ? 'restarting' : 'starting');
  await s.beforeStart?.();
  try {
    run.handle = await s.host.connectMcp(
      s.launch((info) => onServerExit(run, s, info)),
      s.source,
    );
    delete run.lastError;
    set(run, s, 'running');
  } catch (err) {
    run.lastError = (err as Error).message;
    set(run, s, 'failed', run.lastError);
    throw s.startError(run.lastError, err);
  }
}

/** Stop it on purpose; resolves once the process has exited (so its folder can be removed). */
export async function stopServer(run: SupervisedRun, s: Supervision): Promise<void> {
  run.stopping = true;
  const h = run.handle;
  delete run.handle;
  if (h) {
    try {
      await h.disconnect();
    } catch {
      // already gone
    }
  }
  if (run.status !== 'failed') set(run, s, 'stopped');
}

/** Stop and start again with a fresh count of crashes (settings changed). */
export async function restartServer(run: SupervisedRun, s: Supervision): Promise<void> {
  await stopServer(run, s);
  run.restarts = [];
  await startServer(run, s).catch(() => undefined);
}

/** It ended: on purpose, nothing; a crash, a restart with backoff, or too many in the window and it is given up. */
function onServerExit(run: SupervisedRun, s: Supervision, info: McpExit): void {
  if (info.expected || run.stopping || !s.alive()) return;
  const dead = run.handle;
  delete run.handle;
  const dropped = Promise.resolve()
    .then(() => dead?.disconnect()) // drop the dead server's tools before restarting
    .catch(() => undefined);
  const now = Date.now();
  run.restarts = run.restarts.filter((t) => now - t < s.restart.windowMs);
  const tail = info.stderrTail.trim().split('\n').slice(-3).join(' / ');
  s.log(`exited (code ${info.code ?? '?'})${tail ? `: ${tail}` : ''}`);
  if (run.restarts.length >= s.restart.maxRestarts) {
    run.lastError = s.crashMessage(run.restarts.length + 1, Math.round(s.restart.windowMs / 1000));
    set(run, s, 'failed', run.lastError);
    s.gaveUp(run.lastError);
    return;
  }
  run.restarts.push(now);
  const delay = 250 * 2 ** (run.restarts.length - 1);
  setTimeout(() => {
    void dropped
      .then(() => {
        if (!s.alive() || run.stopping) return;
        return s.serial(() => startServer(run, s));
      })
      .catch(() => undefined);
  }, delay);
}
