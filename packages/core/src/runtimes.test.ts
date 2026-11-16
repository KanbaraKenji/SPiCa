// run_command's `node` on a computer without one, and what the model is told it can run.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledNode, findOnPath, listNodeLibs, pathOf, probeRuntimes, runtimesLine, withNode, withNodeLibs, writeNodeShim } from './runtimes.ts';
import { createRunCommandTool } from './tools/command-tool.ts';
import { tempDir } from './testing/helpers.ts';
import type { ToolContext } from './tools/types.ts';

vi.setConfig({ testTimeout: 60_000 });
const win = process.platform === 'win32';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

/** The PATH of this process without any folder that has a node or python in it. */
function pathWithout(...names: string[]): string {
  return pathOf(process.env)
    .value.split(delimiter)
    .filter((d) => d && !names.some((n) => findOnPath(n, { PATH: d, PATHEXT: process.env.PATHEXT })))
    .join(delimiter);
}

describe('node in run_command', () => {
  it('a PATH that finds node is left as it is (the computer’s own Node comes first)', () => {
    const env = { PATH: dirname(process.execPath), PATHEXT: process.env.PATHEXT ?? '' };
    expect(withNode(env, join(dir, 'shim'))).toEqual({ env, bundled: false });
    expect(existsSync(join(dir, 'shim'))).toBe(false);
  });

  it('without one, the app’s Node is put at the end of PATH, and node runs', async () => {
    const env = { PATH: pathWithout('node'), PATHEXT: process.env.PATHEXT ?? '', SystemRoot: process.env.SystemRoot ?? '' };
    const r = withNode(env, join(dir, 'shim'));
    expect(r.bundled).toBe(true);
    expect(pathOf(r.env).value.endsWith(`${delimiter}${join(dir, 'shim')}`)).toBe(true);
    expect(findOnPath('node', r.env)).toBeTruthy();
    // through run_command itself: the command's environment has no node on PATH
    const key = pathOf(process.env).key;
    const saved = process.env[key];
    process.env[key] = env.PATH;
    try {
      const tool = createRunCommandTool({ nodeShimDir: join(dir, 'shim2') });
      const ctx = { cwd: dir, signal: new AbortController().signal, emit: () => {} } as unknown as ToolContext;
      const out = await tool.execute({ command: 'node -e "console.log(\'sum=\' + (1 + 2))"' }, ctx);
      expect(out.content).toContain('sum=3');
    } finally {
      process.env[key] = saved;
    }
  });

  it('the app’s Electron runs as Node through the stand-in (ELECTRON_RUN_AS_NODE), no window', () => {
    let electron: string;
    try {
      electron = createRequire(join(process.cwd(), 'apps', 'desktop', 'package.json'))('electron') as string;
    } catch {
      return; // electron is not installed here
    }
    const shim = writeNodeShim(join(dir, 'eshim'), { exe: electron, asNode: true, version: '?' });
    const file = join(shim, win ? 'node.cmd' : 'node');
    const out = execFileSync(win ? 'cmd.exe' : file, win ? ['/d', '/c', file, '-e', 'console.log(process.versions.node, typeof require("fs").readFileSync)'] : ['-e', 'console.log(process.versions.node, typeof require("fs").readFileSync)'], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+ function$/);
  });

  it('the stand-in is written once and rewritten when the app moves', () => {
    const a = writeNodeShim(join(dir, 's'), { exe: 'C:\\A\\app.exe', asNode: true, version: '1' });
    const b = writeNodeShim(join(dir, 's'), { exe: 'C:\\B\\app.exe', asNode: true, version: '1' });
    expect(a).toBe(b);
    expect(execFileSync(win ? 'cmd.exe' : 'cat', win ? ['/d', '/c', 'type', join(b, 'node.cmd')] : [join(b, 'node')], { encoding: 'utf8' })).toContain('B');
  });
});

describe('the app’s libraries for scripts', () => {
  function fakeLib(root: string, name: string, version: string, body: string): void {
    mkdirSync(join(root, 'node_modules', name), { recursive: true });
    writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
    writeFileSync(join(root, 'node_modules', name, 'index.js'), body);
  }

  it('are listed by name and version; a missing folder lists none', () => {
    fakeLib(dir, 'papaparse', '5.7.1', '');
    fakeLib(dir, 'exceljs', '4.4.0', '');
    mkdirSync(join(dir, 'node_modules', 'not-a-lib'));
    expect(listNodeLibs(dir)).toEqual([
      { name: 'exceljs', version: '4.4.0' },
      { name: 'papaparse', version: '5.7.1' },
    ]);
    expect(listNodeLibs(join(dir, 'missing'))).toEqual([]);
    expect(listNodeLibs(undefined)).toEqual([]);
  });

  it('go last on NODE_PATH, after the user’s own; nothing changes without the folder', () => {
    fakeLib(dir, 'x', '1.0.0', '');
    const libs = join(dir, 'node_modules');
    expect(withNodeLibs({ PATH: 'p' }, dir)).toEqual({ PATH: 'p', NODE_PATH: libs });
    expect(withNodeLibs({ NODE_PATH: 'mine' }, dir)).toEqual({ NODE_PATH: `mine${delimiter}${libs}` });
    expect(withNodeLibs({ NODE_PATH: libs }, dir)).toEqual({ NODE_PATH: libs });
    expect(withNodeLibs({ PATH: 'p' }, join(dir, 'missing'))).toEqual({ PATH: 'p' });
  });

  it('a script run by run_command requires one, with no node_modules next to it', async () => {
    const libs = join(dir, 'libs');
    fakeLib(libs, 'spica-test-lib', '1.0.0', 'module.exports = (a, b) => a * b;');
    const work = join(dir, 'work');
    mkdirSync(work);
    writeFileSync(join(work, 'go.js'), "console.log('product=' + require('spica-test-lib')(6, 7));");
    const tool = createRunCommandTool({ nodeShimDir: join(dir, 'shim'), nodeLibsDir: libs });
    const ctx = { cwd: work, signal: new AbortController().signal, emit: () => {} } as unknown as ToolContext;
    const out = await tool.execute({ command: 'node go.js' }, ctx);
    expect(out.content).toContain('product=42');
  });

  it('the model is told it can require them (not import), and that the app’s Node has no npm', () => {
    const libs = [
      { name: 'exceljs', version: '4.4.0' },
      { name: 'papaparse', version: '5.7.1' },
    ];
    expect(runtimesLine({ node: { version: '24.1.0', source: 'bundled' }, nodeLibs: libs })).toContain(
      "Node.js 24.1.0 (the app's own, without npm; `node` works in run_command; scripts can `require` (not import) `exceljs` 4.4.0 for .xlsx, `papaparse` 5.7.1 for CSV, which the app provides)",
    );
    expect(runtimesLine({ node: { version: '22.0.0', source: 'system' }, nodeLibs: libs })).toContain('(installed on this computer; scripts can `require`');
  });

  it('are found when the runtimes are probed', async () => {
    fakeLib(dir, 'exceljs', '4.4.0', '');
    const r = await probeRuntimes(process.env, bundledNode(), { nodeLibsDir: dir });
    expect(r.nodeLibs).toEqual([{ name: 'exceljs', version: '4.4.0' }]);
  });
});

describe('what the model is told', () => {
  function fakeProgram(folder: string, name: string, print: string, code = 0): void {
    mkdirSync(folder, { recursive: true });
    if (win) writeFileSync(join(folder, `${name}.cmd`), `@echo off\r\necho ${print}\r\nexit /b ${code}\r\n`);
    else writeFileSync(join(folder, name), `#!/bin/sh\necho "${print}"\nexit ${code}\n`, { mode: 0o755 });
  }

  it('no Python, and a Store stand-in that only offers to install it does not count', async () => {
    const stub = join(dir, 'stub');
    fakeProgram(stub, win ? 'python' : 'python3', 'Python was not found; run without arguments to install from the Microsoft Store', 9009);
    const r = await probeRuntimes({ PATH: [pathWithout('node', 'python', 'python3', 'py'), stub].join(delimiter), PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot });
    expect(r.python).toBeUndefined();
    expect(r.node).toEqual({ version: bundledNode().version, source: 'bundled' });
    if (win) expect(r.powershell).toMatch(/^\d+\.\d+/);
    const line = runtimesLine(r);
    expect(line).toContain(`Node.js ${bundledNode().version} (the app's own`);
    expect(line).toContain('no Python');
  });

  it('a Python on PATH, with its version and command', async () => {
    const py = join(dir, 'py');
    fakeProgram(py, win ? 'python' : 'python3', 'Python 3.12.1');
    const r = await probeRuntimes({ PATH: [pathWithout('python', 'python3', 'py'), py].join(delimiter), PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot });
    expect(r.python).toEqual({ version: '3.12.1', command: win ? 'python' : 'python3' });
    expect(runtimesLine(r)).toContain('Python 3.12.1');
  });

  it('the line is in the system prompt of a conversation that has run_command, once the runtimes are known', async () => {
    const { startGateway, makeRuntime } = await import('./testing/helpers.ts');
    const gw = await startGateway();
    try {
      const runtimes = { node: { version: '22.1.0', source: 'bundled' as const } };
      const rt = makeRuntime(gw, { runtimes, tools: [createRunCommandTool()] });
      gw.enqueue({ text: 'ok' });
      await rt.createSession({ cwd: dir }).send('hi').done;
      expect(JSON.stringify(gw.requests[0])).toContain('Runtimes on this computer for run_command: Node.js 22.1.0');
      const none = makeRuntime(gw, { tools: [createRunCommandTool()] });
      gw.enqueue({ text: 'ok' });
      await none.createSession({ cwd: dir }).send('hi').done;
      expect(JSON.stringify(gw.requests[1])).not.toContain('Runtimes on this computer');
    } finally {
      await gw.stop();
    }
  });
});
