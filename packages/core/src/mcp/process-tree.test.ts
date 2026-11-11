// Stopping a server with endTree ends what it started, except a program started
// through a launcher that has exited. Real processes on Windows; ends only the
// PIDs this test started.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpStdioClient } from './client.ts';
import { registryLister } from '../testing/process-list.ts';
import { descendants, endTree, fileTime, listProcesses, useProcessLister, type ProcessInfo } from './process-tree.ts';

vi.setConfig({ testTimeout: 60_000 });

describe('process tree rules', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const at = (ms: number) => fileTime(t0 + ms);
  const map = (list: ProcessInfo[]) => new Map(list.map((p) => [p.pid, p]));

  it('follows parents, but never to a process older than its parent', () => {
    const procs = map([
      { pid: 10, ppid: 1, created: at(0) }, // the server
      { pid: 11, ppid: 10, created: at(100) }, // its child
      { pid: 12, ppid: 11, created: at(200) }, // grandchild
      { pid: 13, ppid: 10, created: at(-50_000) }, // older than the server: an earlier owner of PID 10 started it
      { pid: 14, ppid: 99, created: at(300) }, // started by a launcher (99) that has exited
    ]);
    expect(descendants(procs, 10, t0).map((p) => p.pid).sort()).toEqual([11, 12]);
  });

  it('a server that has exited still has its tree; a PID taken by another process has none', () => {
    const procs = map([{ pid: 21, ppid: 10, created: at(500) }]);
    expect(descendants(procs, 10, t0).map((p) => p.pid)).toEqual([21]);
    const reused = map([
      { pid: 10, ppid: 1, created: at(60_000) },
      { pid: 21, ppid: 10, created: at(61_000) },
    ]);
    expect(descendants(reused, 10, t0)).toEqual([]);
  });
});

const win = process.platform === 'win32';
const node = process.execPath;
const dirs: string[] = [];
const mine: number[] = [];
afterEach(() => {
  for (const pid of mine.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A test process: registers its PID under its role and stays until ended.
const STAY = `require('node:fs').writeFileSync(require('node:path').join(process.env.REG, process.argv[1] + '-' + process.pid + '-' + process.ppid), ''); setInterval(() => {}, 1 << 30);`;
// the same as a file, for the cmd.exe line (argv[1] is then the file, the role comes after it)
const STAY_FILE_TEXT = STAY.replace('process.argv[1]', 'process.argv[2]');
// A server that starts: an ordinary child, a detached one, a grandchild (via a child), and one through a launcher that exits.
const SERVER = `
const { spawn } = require('node:child_process');
const stay = process.env.STAY;
const hide = { windowsHide: true, stdio: 'ignore' };
spawn(process.execPath, ['-e', stay, 'plain'], hide);
spawn(process.execPath, ['-e', stay, 'detached'], { ...hide, detached: true }).unref();
// a grandchild started by a non-Node program (cmd.exe), which does not tie its children to itself
const cmd = spawn('cmd.exe', ['/d', '/s', '/c', '""' + process.execPath + '" "' + process.env.STAY_FILE + '" grandchild"'], { ...hide, windowsVerbatimArguments: true });
require('node:fs').writeFileSync(require('node:path').join(process.env.REG, 'cmd-' + cmd.pid + '-' + process.pid), '');
spawn(process.execPath, ['-e', "require('node:child_process').spawn(process.execPath, ['-e', process.env.STAY, 'launched'], { windowsHide: true, stdio: 'ignore', detached: true }).unref()"], hide);
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 't' } } });
}).on('close', () => process.exit(0));
`;

async function startTree(endTreeOn: boolean): Promise<{ c: McpStdioClient; pids: Record<string, number> }> {
  const reg = mkdtempSync(join(tmpdir(), 'spica-tree-'));
  dirs.push(reg);
  const files = mkdtempSync(join(tmpdir(), 'spica-tree-files-'));
  dirs.push(files);
  const stayFile = join(files, 'stay.cjs');
  writeFileSync(stayFile, STAY_FILE_TEXT);
  const c = new McpStdioClient({ name: 't', command: node, args: ['-e', SERVER], env: { REG: reg, STAY, STAY_FILE: stayFile }, endTree: endTreeOn });
  await c.connect();
  const want = ['plain', 'detached', 'cmd', 'grandchild', 'launched'];
  const t = Date.now();
  let pids: Record<string, number> = {};
  while (Date.now() - t < 20_000) {
    pids = Object.fromEntries(readdirSync(reg).map((f) => [f.split('-')[0]!, Number(f.split('-')[1])]));
    if (want.every((r) => pids[r])) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  mine.push(...Object.values(pids));
  expect(Object.keys(pids).sort()).toEqual([...want].sort());
  void readFileSync;
  return { c, pids };
}

describe('process lists', () => {
  afterEach(() => useProcessLister());

  it('the real list has this process with its parent', async () => {
    const { procs, error } = await listProcesses({ notBefore: Date.now(), timeoutMs: 80_000 });
    if (win) {
      expect(error).toBeUndefined();
      expect(procs.get(process.pid)).toMatchObject({ pid: process.pid, ppid: process.ppid });
    } else expect(procs.size).toBe(0); // only listed on Windows
  }, 90_000);

  it('one list serves stops close together, but never one taken before the server started', async () => {
    useProcessLister(async () => ({ procs: new Map() }));
    const serverStarted = Date.now() - 1_000;
    const a = listProcesses({ notBefore: serverStarted });
    expect(listProcesses({ notBefore: serverStarted })).toBe(a); // another server, a moment later: the same list
    await new Promise((r) => setTimeout(r, 5));
    expect(listProcesses({ notBefore: Date.now() })).not.toBe(a); // a server started after it: a new list
    await a;
  });
});

describe.runIf(win)('stopping a server with endTree (Windows)', () => {
  // the processes these tests started, listed at once (no waiting for the machine's list)
  beforeEach(() => useProcessLister(registryLister(() => dirs.filter((d) => existsSync(d)))));
  afterEach(() => useProcessLister());

  it('a server that has already ended is not looked into, so a restart does not wait', async () => {
    const BARE = `require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l); if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 'b' } } }) + '\\n'); });`;
    const c = new McpStdioClient({ name: 'gone', command: node, args: ['-e', BARE], endTree: true });
    await c.connect();
    // end it the way a crash would, without close()
    process.kill(c.pid!);
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    await c.close();
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('ends the ordinary, detached and grandchild processes; leaves one started through an exited launcher', async () => {
    const { c, pids } = await startTree(true);
    await c.close();
    expect({ plain: alive(pids.plain!), detached: alive(pids.detached!), grandchild: alive(pids.grandchild!), launched: alive(pids.launched!) }).toEqual({
      plain: false,
      detached: false,
      grandchild: false,
      launched: true,
    });
  });

  it('without endTree only the server and its ordinary children end (the behaviour before)', async () => {
    const { c, pids } = await startTree(false);
    await c.close();
    await new Promise((r) => setTimeout(r, 300));
    expect({ plain: alive(pids.plain!), detached: alive(pids.detached!), grandchild: alive(pids.grandchild!), launched: alive(pids.launched!) }).toEqual({
      plain: false,
      detached: true,
      grandchild: true,
      launched: true,
    });
  });

  it('ends a recorded process only when its PID still belongs to it', async () => {
    const reg = mkdtempSync(join(tmpdir(), 'spica-tree-'));
    dirs.push(reg);
    const { spawn } = await import('node:child_process');
    const p = spawn(node, ['-e', STAY, 'other'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, REG: reg } });
    mine.push(p.pid!);
    // wait until it has registered (a busy machine starts processes slowly)
    for (const t0 = Date.now(); readdirSync(reg).length === 0 && Date.now() - t0 < 20_000; ) await new Promise((r) => setTimeout(r, 50));
    const real = (await listProcesses({ notBefore: Date.now() })).procs.get(p.pid!)!;
    expect(real).toBeDefined();
    // recorded with another creation time: someone else's process now, so it is left alone
    expect(await endTree([{ ...real, created: real.created - 10n }], Date.now())).toBe(0);
    expect(alive(p.pid!)).toBe(true);
    expect(await endTree([real], Date.now())).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(p.pid!)).toBe(false);
  });
});
