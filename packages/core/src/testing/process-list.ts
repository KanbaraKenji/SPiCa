// A quick stand-in for the machine's process list (useProcessLister), for tests:
// only the processes a test registered, as files named `<role>-<pid>-<ppid>`
// (any extension) in its folders, each with a creation time fixed when first
// seen. A real list takes a second or more, many more on a busy machine.
import { readdirSync } from 'node:fs';
import { fileTime, type ProcessInfo, type ProcessList } from '../mcp/process-tree.ts';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function registryLister(folders: () => string[]): (timeoutMs: number) => Promise<ProcessList> {
  const created = new Map<number, bigint>();
  return async () => {
    const procs = new Map<number, ProcessInfo>();
    for (const dir of folders()) {
      for (const name of readdirSync(dir)) {
        const m = /-(\d+)-(\d+)(\.\w+)?$/.exec(name);
        if (!m) continue;
        const pid = Number(m[1]);
        if (!alive(pid)) continue;
        if (!created.has(pid)) created.set(pid, fileTime(Date.now()));
        procs.set(pid, { pid, ppid: Number(m[2]), created: created.get(pid)! });
      }
    }
    return { procs };
  };
}
