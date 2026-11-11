// Reinstalling the version that is installed and running (common while
// developing: code changed, version not bumped). On Windows a running
// process's working folder and the files it has open cannot be deleted, so
// the plugin must be stopped, and its processes gone, before its folder is
// replaced.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
