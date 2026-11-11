// Reinstalling the version that is installed and running (common while
// developing: code changed, version not bumped). On Windows a running
// process's working folder and the files it has open cannot be deleted, so
// the plugin must be stopped, and its processes gone, before its folder is
// replaced.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeHost } from './host.ts';
import { PluginManager, fsOps, type InstallStep } from './manager.ts';
import { manifest, rig, toolNames, writePlugin, type Rig } from './testing/helpers.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let r: Rig | undefined;
const dirs: string[] = [];
afterEach(async () => {
  if (r) {
    await r.pm.shutdown();
    // Helpers that never exit by themselves were left running on purpose.
    for (const name of await readdir(join(r.root, 'data')).catch(() => [] as string[])) await killHelpers(join(r.root, 'data', name));
    await r.cleanup();
  }
  r = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

/** The helper a server starts: holds the plugin folder as its working folder; `lingerMs` after its stdin closes it exits (never, when -1). */
const HELPER = `const linger = Number(process.argv[2]);
require('node:fs').writeFileSync(require('node:path').join(process.env.SPICA_PLUGIN_DATA, 'helper-' + process.pid + '.pid'), '');
setInterval(() => {}, 1000);
process.stdin.on('end', () => { if (linger >= 0) setTimeout(() => process.exit(0), linger); });
process.stdin.resume();
`;

/**
 * An MCP server with one tool, ping; with `helper` it first starts helper.cjs
 * detached, so it outlives the server (on Windows a non-detached child of a Node
 * server is ended with it; a detached one, or one a bundled .exe starts, is not).
 */
const server = (helper: number | null) => `import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
${helper === null ? '' : `spawn(process.execPath, ['helper.cjs', '${helper}'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });`}
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's' } } });
  if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } });
  if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: 'pong' }] } });
});
`;

async function plugin(name: string, helper: number | null): Promise<string> {
  const dir = await writePlugin({
    'manifest.json': manifest(name),
    'mcp/srv.json': { runtime: 'node', entry: 'srv.js' },
    'srv.js': server(helper),
    'package.json': { type: 'module' },
    'helper.cjs': HELPER,
  });
  dirs.push(dir);
  return dir;
}

describe('reinstalling the running version', () => {
  for (const [label, helper] of [
    ['a plain server', null],
    ['a server whose helper process exits a moment after the server', 1500],
  ] as const) {
    it(`${label}: three reinstalls in a row succeed and the tools come back`, async () => {
      const name = helper === null ? 'reinst-plain' : 'reinst-helper';
      r = await rig();
      const src = await plugin(name, helper);
      await r.pm.install(src);
      await r.pm.enable(name);
      expect(toolNames(r.rt)).toContain(`${name}__ping`);
      for (let i = 0; i < 3; i++) {
        const d = await r.pm.install(src);
        expect(d).toMatchObject({ enabled: true, version: '1.0.0' });
        expect(d.servers[0]).toMatchObject({ status: 'running' });
        expect(toolNames(r.rt)).toContain(`${name}__ping`);
      }
    });
  }
});

/** Stop helpers left running on purpose (they never exit by themselves). */
async function killHelpers(dataDir: string): Promise<void> {
  for (const f of await readdir(dataDir).catch(() => [] as string[])) {
    const m = /^helper-(\d+)\.pid$/.exec(f);
    if (!m) continue;
    try {
      process.kill(Number(m[1]));
    } catch {
      // already gone
    }
  }
}

describe("when the plugin's processes do not let go", () => {
  it('a helper that never exits: the reinstall is refused plainly and the plugin keeps working; once it is gone, the reinstall works', async () => {
    r = await rig();
    const src = await plugin('reinst-stuck', -1);
    await r.pm.install(src);
    await r.pm.enable('reinst-stuck');
    const data = r.pm.dataDir('reinst-stuck');
    try {
      await expect(r.pm.install(src)).rejects.toThrow('「reinst-stuck」1.0.0 的安装文件夹仍被占用，未安装。请关闭插件启动的程序后重试。');
      expect(r.pm.describe('reinst-stuck')).toMatchObject({ enabled: true, servers: [{ status: 'running' }] });
      expect(toolNames(r.rt)).toContain('reinst-stuck__ping');
      // Nothing half-copied is left beside the installed version.
      expect((await readdir(join(r.pm.root, 'installed', 'reinst-stuck'))).sort()).toEqual(['1.0.0']);
    } finally {
      await killHelpers(data);
    }
    // The plugin was started again on its old files, with a new helper: once that one is gone too, the reinstall works.
    await new Promise((done) => setTimeout(done, 500));
    await killHelpers(data);
    const d = await r.pm.install(src);
    expect(d).toMatchObject({ enabled: true, servers: [{ status: 'running' }] });
  });

  it('a helper that never exits: uninstall is refused, the plugin keeps working with all its files; once it is gone, uninstall works', async () => {
    r = await rig();
    await r.pm.install(await plugin('uninst-stuck', -1));
    await r.pm.enable('uninst-stuck');
    const data = r.pm.dataDir('uninst-stuck');
    try {
      await expect(r.pm.uninstall('uninst-stuck')).rejects.toThrow('「uninst-stuck」的安装文件夹仍被占用，未卸载。请关闭插件启动的程序后重试。');
      expect(r.pm.describe('uninst-stuck')).toMatchObject({ enabled: true, servers: [{ status: 'running' }] });
      expect(toolNames(r.rt)).toContain('uninst-stuck__ping');
      expect((await readdir(r.pm.installDir('uninst-stuck', '1.0.0'))).sort()).toEqual(['helper.cjs', 'manifest.json', 'mcp', 'package.json', 'srv.js']);
    } finally {
      await killHelpers(data);
    }
    await new Promise((done) => setTimeout(done, 500));
    await killHelpers(data);
    await r.pm.uninstall('uninst-stuck');
    expect(await readdir(join(r.pm.root, 'installed'))).toEqual([]);
  });

  it('uninstall waits for a helper that exits a moment after the server', async () => {
    r = await rig();
    await r.pm.install(await plugin('uninst-helper', 1500));
    await r.pm.enable('uninst-helper');
    await r.pm.uninstall('uninst-helper');
    expect(existsSync(join(r.pm.root, 'installed', 'uninst-helper'))).toBe(false);
    expect(r.pm.list().map((p) => p.name)).not.toContain('uninst-helper');
  });

  it('the same version with new code that does not start: the previous files come back and run', async () => {
    r = await rig();
    const src = await plugin('reinst-broken', null);
    await r.pm.install(src);
    await r.pm.enable('reinst-broken');
    await writeFile(join(src, 'srv.js'), 'process.exit(3);\n');
    await expect(r.pm.install(src)).rejects.toThrow(/新版本 1\.0\.0 启动失败，已回退到 1\.0\.0/);
    expect(r.pm.describe('reinst-broken')).toMatchObject({ enabled: true, servers: [{ status: 'running' }] });
    expect(toolNames(r.rt)).toContain('reinst-broken__ping');
    expect(await readFile(join(r.pm.installDir('reinst-broken', '1.0.0'), 'srv.js'), 'utf8')).toContain('tools/list');
    expect((await readdir(join(r.pm.root, 'installed', 'reinst-broken'))).sort()).toEqual(['1.0.0']);
  });
});

describe('when another program holds a folder (acted out: a virus scanner reading the fresh copy)', () => {
  const realRename = fsOps.rename;
  const realWait = fsOps.busyWaitMs;
  afterEach(() => {
    fsOps.rename = realRename;
    fsOps.busyWaitMs = realWait;
  });
  /** rename fails with EBUSY while `held` says so. */
  const holdWhen = (held: (from: string, to: string) => boolean) => {
    fsOps.busyWaitMs = 400;
    fsOps.rename = async (from, to) => {
      if (held(String(from), String(to))) throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${String(from)}'`), { code: 'EBUSY' });
      return realRename(from, to);
    };
  };

  it('says each step while it reinstalls, and keeps saying how long the folder has been held while it retries', async () => {
    r = await rig();
    const src = await plugin('reinst-steps', null);
    const first: string[] = [];
    await r.pm.install(src, undefined, { onProgress: (p) => first.push(p.step) });
    // A fresh install: only the copy (it is not on yet, nothing to stop or start).
    expect(first).toEqual(['copy']);
    await r.pm.enable('reinst-steps');
    let tries = 0;
    holdWhen((from) => from.includes('~new-') && ++tries <= 3);
    fsOps.busyWaitMs = 5000;
    const steps: InstallStep[] = [];
    await r.pm.install(src, undefined, { onProgress: (p) => steps.push(p) });
    expect([...new Set(steps.map((p) => p.step))]).toEqual(['copy', 'stop', 'replace', 'start']);
    const held = steps.filter((p): p is Extract<InstallStep, { step: 'replace' }> => p.step === 'replace' && p.busyMs !== undefined);
    expect(held).toHaveLength(3);
    expect(held[2]!.busyMs).toBeGreaterThanOrEqual(held[0]!.busyMs!);
    expect(r.pm.describe('reinst-steps')).toMatchObject({ enabled: true, servers: [{ status: 'running' }] });
  });

  it('the new copy cannot be moved in: the old files go back, the plugin runs as before, nothing is left beside it', async () => {
    r = await rig();
    const src = await plugin('reinst-scan', null);
    await r.pm.install(src);
    await r.pm.enable('reinst-scan');
    await writeFile(join(src, 'srv.js'), `${await readFile(join(src, 'srv.js'), 'utf8')}// new code\n`);
    holdWhen((from) => from.includes('~new-'));
    await expect(r.pm.install(src)).rejects.toThrow('「reinst-scan」1.0.0 的安装文件夹仍被占用，未安装。请关闭插件启动的程序后重试。');
    expect(r.pm.describe('reinst-scan')).toMatchObject({ enabled: true, version: '1.0.0', servers: [{ status: 'running' }] });
    expect(toolNames(r.rt)).toContain('reinst-scan__ping');
    expect(await readFile(join(r.pm.installDir('reinst-scan', '1.0.0'), 'srv.js'), 'utf8')).not.toContain('// new code');
    expect(await readdir(join(r.pm.root, 'installed', 'reinst-scan'))).toEqual(['1.0.0']);
    // Once the folder is free, the same install works.
    fsOps.rename = realRename;
    await r.pm.install(src);
    expect(await readFile(join(r.pm.installDir('reinst-scan', '1.0.0'), 'srv.js'), 'utf8')).toContain('// new code');
  });

  it('new code that does not start and old files that cannot be put back: says so, and the plugin is left off', async () => {
    r = await rig();
    const src = await plugin('reinst-stuckback', null);
    await r.pm.install(src);
    await r.pm.enable('reinst-stuckback');
    await writeFile(join(src, 'srv.js'), 'process.exit(3);\n');
    holdWhen((_from, to) => to.includes('~bad-'));
    await expect(r.pm.install(src)).rejects.toThrow(/新版本 1\.0\.0 启动失败，旧文件未能恢复（安装文件夹仍被占用），插件已停用/);
    expect(r.pm.describe('reinst-stuckback')).toMatchObject({ enabled: false });
    expect(JSON.parse(await readFile(join(r.pm.root, 'state.json'), 'utf8')).plugins['reinst-stuckback'].enabled).toBe(false);
  });

  it('folders an interrupted install or uninstall left aside are removed at the next start; real versions stay', async () => {
    r = await rig();
    await r.pm.install(await plugin('leftovers', null));
    const base = join(r.pm.root, 'installed');
    await mkdir(join(base, 'leftovers', '1.0.0~old-abc1-2'), { recursive: true });
    await mkdir(join(base, 'leftovers', '1.0.0~new-abc1-3'), { recursive: true });
    await mkdir(join(base, 'leftovers', '1.0.0-rc.old-2'), { recursive: true });
    await mkdir(join(base, 'gone~removing-abc1'), { recursive: true });
    const again = new PluginManager({ host: runtimeHost(r.rt), root: r.pm.root });
    await again.load();
    expect((await readdir(base)).sort()).toEqual(['leftovers']);
    expect((await readdir(join(base, 'leftovers'))).sort()).toEqual(['1.0.0', '1.0.0-rc.old-2']);
    await again.shutdown();
  });

  it('when the folder left aside is the only copy (cut short mid-swap, or mid-uninstall), it is put back instead', async () => {
    r = await rig();
    await r.pm.install(await plugin('midswap', null));
    await r.pm.install(await plugin('midremove', null));
    await r.pm.enable('midswap');
    await r.pm.shutdown();
    const base = join(r.pm.root, 'installed');
    // Reinstall cut short: the old files were moved aside, the new ones never moved in.
    await rename(join(base, 'midswap', '1.0.0'), join(base, 'midswap', '1.0.0~old-abc1-2'));
    await mkdir(join(base, 'midswap', '1.0.0~new-abc1-2'), { recursive: true });
    // Uninstall cut short: the folder was moved aside, the record still says installed.
    await rename(join(base, 'midremove'), join(base, 'midremove~removing-abc1'));
    const again = new PluginManager({ host: runtimeHost(r.rt), root: r.pm.root });
    const loaded = await again.load();
    expect(loaded.enabled).toEqual(['midswap']);
    expect((await readdir(base)).sort()).toEqual(['midremove', 'midswap']);
    expect(await readdir(join(base, 'midswap'))).toEqual(['1.0.0']);
    expect(await readdir(join(base, 'midremove', '1.0.0'))).toContain('srv.js');
    expect(toolNames(r.rt)).toContain('midswap__ping');
    await again.shutdown();
  });
});
