// The processes a plugin's MCP server started (and those started by them), so
// that stopping the server ends them too: on Windows nothing else does, and a
// process left behind keeps the plugin's install folder busy.
//
// Windows only. A process is in the server's tree when its parent is the server
// or another process of the tree, and it was created after that parent (a PID
// can be reused; a process can never be older than its parent). A program
// started through a launcher that has already exited has a parent that is no
// longer there: it is outside the tree and is never touched. Elsewhere the
// lists are empty and only the server itself is stopped.
import { execFile } from 'node:child_process';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Creation time as a Windows FILETIME (100 ns units since 1601). */
  created: bigint;
}

const QUERY =
  'Get-CimInstance -Query "SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process" | ' +
  'ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" }';

export interface ProcessList {
  procs: Map<number, ProcessInfo>;
  /** Why the list is empty, when it could not be taken. */
  error?: string;
}

/** Every process on the machine with its parent and creation time; empty (with `error`) when it cannot be listed. */
function takeList(timeoutMs: number): Promise<ProcessList> {
  if (process.platform !== 'win32') return Promise.resolve({ procs: new Map() });
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', QUERY], { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      const procs = new Map<number, ProcessInfo>();
      if (err) return resolve({ procs, error: err.killed ? `no list within ${timeoutMs / 1000} s` : err.message });
      for (const line of String(out).split(/\r?\n/)) {
        const m = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
        if (m) procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), created: BigInt(m[3]!) });
      }
      resolve(procs.size > 0 ? { procs } : { procs, error: 'the process list came back empty' });
    });
  });
}

/**
 * How a list is taken. Tests put in a quick one made of the processes they
 * started (a real list takes about a second, many more on a busy machine);
 * `undefined` puts the real one back.
 */
export function useProcessLister(take?: (timeoutMs: number) => Promise<ProcessList>): void {
  lister = take ?? takeList;
  recent = undefined;
}
let lister = takeList;

// One list serves several stops that come close together (the app stops its
// plugins one after another; each list takes about a second).
let recent: { startedAt: number; list: Promise<ProcessList> } | undefined;

/**
 * A process list taken no earlier than `notBefore` (ms) and less than `maxAgeMs`
 * ago: the latest one when it qualifies (also while still being taken), else a
 * new one. Processes started after the list was taken are not in it.
 */
export function listProcesses(opts: { notBefore?: number; maxAgeMs?: number; timeoutMs?: number } = {}): Promise<ProcessList> {
  const now = Date.now();
  const { notBefore = now, maxAgeMs = 5_000, timeoutMs = 3_000 } = opts;
  if (recent && recent.startedAt >= notBefore && now - recent.startedAt < maxAgeMs) return recent.list;
  const list = lister(timeoutMs);
  recent = { startedAt: now, list };
  return list;
}

const MS = 10_000n; // FILETIME units in a millisecond

/** A JavaScript time (ms) as a Windows FILETIME. */
export function fileTime(ms: number): bigint {
  return (BigInt(Math.round(ms)) + 11_644_473_600_000n) * MS;
}

/**
 * The descendants of `rootPid` in `procs`. `rootStartedMs` is when the root was
 * started (it may have exited already); if a different process now holds its
 * PID, the tree is empty.
 */
export function descendants(procs: Map<number, ProcessInfo>, rootPid: number, rootStartedMs: number): ProcessInfo[] {
  const started = fileTime(rootStartedMs);
  const root = procs.get(rootPid);
  // the root's PID now belongs to a process started well after ours: not our tree
  if (root && root.created - started > 5_000n * MS) return [];
  const rootCreated = root?.created ?? started - 2_000n * MS;
  const children = new Map<number, ProcessInfo[]>();
  for (const p of procs.values()) {
    if (p.pid === p.ppid) continue;
    const list = children.get(p.ppid) ?? [];
    list.push(p);
    children.set(p.ppid, list);
  }
  const out: ProcessInfo[] = [];
  const walk = (pid: number, created: bigint): void => {
    for (const c of children.get(pid) ?? []) {
      if (c.created < created || out.includes(c)) continue;
      out.push(c);
      walk(c.pid, c.created);
    }
  };
  walk(rootPid, rootCreated);
  return out;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * End the processes in `tree` that are still running at `deadlineMs`; return
 * at once when none is left before that. Each is ended only after checking
 * that the process with that PID is still the one recorded (same creation time).
 */
export async function endTree(tree: ProcessInfo[], deadlineMs: number, opts: { timeoutMs?: number; log?: (line: string) => void } = {}): Promise<number> {
  let left = tree.filter((p) => alive(p.pid));
  if (left.length === 0) return 0;
  // the list to check creation times against is taken while they get their last moment
  const check = listProcesses({ notBefore: Date.now(), timeoutMs: opts.timeoutMs ?? 10_000 });
  while (left.length > 0 && Date.now() < deadlineMs) {
    await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, deadlineMs - Date.now()))));
    left = left.filter((p) => alive(p.pid));
  }
  if (left.length === 0) return 0;
  const { procs: now, error } = await check;
  if (error) opts.log?.(`[spica] could not check the ${left.length} process(es) this server left running (${error}); they are left as they are`);
  const ending: number[] = [];
  for (const p of left) {
    if (now.get(p.pid)?.created !== p.created) continue; // gone, or the PID is someone else's now
    try {
      process.kill(p.pid);
      ending.push(p.pid);
    } catch {
      // ended meanwhile
    }
  }
  // ending a process is not instant: wait (a little) until they are gone, so their files are free
  const until = Date.now() + 2_000;
  while (ending.some(alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return ending.length;
}
