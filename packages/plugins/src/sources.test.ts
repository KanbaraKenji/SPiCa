// Packaging, shared-folder and HTTP sources, checksums, updates and rollback.
import { createServer, type Server } from 'node:http';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenFetchable } from '@spica/core';

// These tests start real server processes; give them room on a busy machine.
vi.setConfig({ testTimeout: 30_000 });
import { packPlugin, unpackPlugin, verifyPackage } from './pack.ts';
import { checkUpdates, downloadPackage, installAvailable, installZip, listSource, writeIndex, type FetchLike } from './sources.ts';
import type { InstallStep } from './manager.ts';
import { EXAMPLE_PLUGIN, callTool, exampleAt, rig, toolNames, type Rig } from './testing/helpers.ts';
import { readZip, writeZip } from './zip.ts';

let r: Rig | undefined;
const dirs: string[] = [];
let server: Server | undefined;
afterEach(async () => {
  await r?.cleanup();
  r = undefined;
  await new Promise<void>((res) => (server ? server.close(() => res()) : res()));
  server = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'spica-src-test-'));
  dirs.push(d);
  return d;
}

/** Serve a folder over HTTP on a random port. */
async function serve(dir: string): Promise<string> {
  server = createServer(async (req, res) => {
    try {
      const body = await readFile(join(dir, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)));
      res.writeHead(200, { 'content-length': body.length }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  const port = await listenFetchable(server);
  return `http://127.0.0.1:${port}/index.json`;
}

describe('zip and packages', () => {
  it('round-trips files and refuses entries that escape the folder', () => {
    const buf = writeZip([
      { name: 'a.txt', data: Buffer.from('hello '.repeat(100)) },
      { name: 'dir/b.bin', data: Buffer.from([0, 1, 2, 3]) },
    ]);
    expect(readZip(buf).map((e) => [e.name, e.data.length])).toEqual([
      ['a.txt', 600],
      ['dir/b.bin', 4],
    ]);
    expect(() => readZip(writeZip([{ name: '../evil.txt', data: Buffer.from('x') }]))).toThrow(/不安全的路径/);
    expect(() => readZip(writeZip([{ name: 'C:/Windows/evil.txt', data: Buffer.from('x') }]))).toThrow(/不安全的路径/);
    expect(() => readZip(Buffer.from('not a zip at all, just text'))).toThrow(/不是有效的 zip 文件/);
  });

  it('packs the example plugin reproducibly and verifies it', async () => {
    const out = await temp();
    const a = await packPlugin(EXAMPLE_PLUGIN, out);
    expect(a).toMatchObject({ name: 'notes', version: '0.1.0', file: join(out, 'notes-0.1.0.zip') });
    const b = await packPlugin(EXAMPLE_PLUGIN, await temp());
    expect(b.sha256).toBe(a.sha256);
    const buf = await readFile(a.file);
    expect(await verifyPackage(buf, a.sha256)).toMatchObject({ ok: true, folder: { manifest: { name: 'notes' } } });
    const bad = await verifyPackage(buf, 'deadbeef');
    expect(bad.ok).toBe(false);
    expect(bad.folder.issues[0]!.message).toMatch(/校验和不匹配/);
  });

  it('unpacks a zip whose files sit in one top folder (Windows "compressed folder")', async () => {
    const files = ['manifest.json', 'icon.svg', 'mcp/notes.json', 'server/index.js', 'mock/catalog.json'];
    const entries = await Promise.all(files.map(async (f) => ({ name: `notes-folder/${f}`, data: await readFile(join(EXAMPLE_PLUGIN, f)) })));
    const target = await temp();
    const folder = await unpackPlugin(writeZip(entries), target);
    expect(folder.manifest?.name).toBe('notes');
    expect(folder.issues).toEqual([]);
  });

  it('.spicaignore leaves development files out of the package', async () => {
    const src = await exampleAt('0.1.0');
    dirs.push(src);
    await writeFile(join(src, '.spicaignore'), '# dev only\ntest/\n/scripts\n**/*.test.mjs\nmanifest.json\n');
    for (const f of ['test/a.mjs', 'scripts/smoke.mjs', 'server/x.test.mjs', 'docs/test/a.txt', 'docs/tested.txt', 'docs/scripts/b.txt']) {
      await mkdir(dirname(join(src, f)), { recursive: true });
      await writeFile(join(src, f), 'x');
    }
    const p = await packPlugin(src, await temp());
    const names = readZip(await readFile(p.file)).map((e) => e.name);
    expect(names).toContain('manifest.json'); // never ignored
    expect(names).toContain('server/index.js');
    expect(names).toContain('docs/tested.txt');
    expect(names).toContain('docs/scripts/b.txt'); // "/scripts" only means the top folder
    expect(names.filter((n) => /(^|\/)test\/|^scripts\/|\.test\.mjs$|^\.spicaignore$/.test(n))).toEqual([]);
  });

  it('refuses to write a package an ignore rule broke', async () => {
    const src = await exampleAt('0.1.0');
    dirs.push(src);
    await writeFile(join(src, '.spicaignore'), 'server/\n');
    const out = await temp();
    await expect(packPlugin(src, out)).rejects.toThrow(/\.spicaignore/);
    expect(await readdir(out)).toEqual([]);
  });
});

describe('sources, updates and rollback', () => {
  it('shared folder without an index: finds plugin folders and zips', async () => {
    const share = await temp();
    await cp(EXAMPLE_PLUGIN, join(share, 'notes-src'), { recursive: true });
    await packPlugin(await exampleAt('0.2.0'), share);
    const list = await listSource({ kind: 'share', location: share });
    expect(list.map((e) => [e.name, e.version, e.form]).sort()).toEqual([
      ['notes', '0.1.0', 'folder'],
      ['notes', '0.2.0', 'zip'],
    ]);
  });

  it('missing shared folder and unreachable HTTP give plain messages', async () => {
    await expect(listSource({ kind: 'share', location: 'Z:\\no\\such\\share' })).rejects.toThrow(/找不到共享文件夹/);
    await expect(listSource({ kind: 'http', location: 'http://127.0.0.1:9/index.json', label: '测试源' })).rejects.toThrow(/无法连接插件源 测试源/);
  });

  it('update from a shared folder, then roll back', async () => {
    r = await rig();
    await r.pm.install(EXAMPLE_PLUGIN);
    await r.pm.enable('notes');
    await callTool(r.rt, 'notes__write_note', { title: 'keep', text: 'survives updates' });

    const share = await temp();
    await packPlugin(await exampleAt('0.2.0'), share);
    await packPlugin(await exampleAt('0.1.5'), share);
    await writeIndex(share);
    const src = { kind: 'share' as const, location: share };
    const { updates, errors } = await checkUpdates(r.pm, [src]);
    expect(errors).toEqual([]);
    expect(updates.map((u) => [u.name, u.installed, u.available])).toEqual([['notes', '0.1.0', '0.2.0']]);

    const d = await installAvailable(r.pm, updates[0]!.entry);
    expect(d).toMatchObject({ version: '0.2.0', previousVersion: '0.1.0', enabled: true, source: { kind: 'share' } });
    // Still enabled, tools still there, data kept.
    expect(toolNames(r.rt)).toContain('notes__read_note');
    expect((await callTool(r.rt, 'notes__read_note', { title: 'keep' })).content).toContain('survives updates');
    expect((await checkUpdates(r.pm, [src])).updates).toEqual([]);

    const back = await r.pm.rollback('notes');
    expect(back).toMatchObject({ version: '0.1.0', previousVersion: '0.2.0', enabled: true });
    expect(toolNames(r.rt)).toContain('notes__read_note');
    expect((await callTool(r.rt, 'notes__read_note', { title: 'keep' })).content).toContain('survives updates');
  });

  it('HTTP source: index + zip with checksum; a tampered file is not installed', async () => {
    const site = await temp();
    await packPlugin(await exampleAt('0.3.0'), site);
    await writeIndex(site);
    const url = await serve(site);
    r = await rig();
    const list = await listSource({ kind: 'http', location: url });
    expect(list).toMatchObject([{ name: 'notes', version: '0.3.0', location: url.replace('index.json', 'notes-0.3.0.zip') }]);
    expect(list[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Tamper with the published zip: the checksum no longer matches.
    const zipPath = join(site, 'notes-0.3.0.zip');
    const good = await readFile(zipPath);
    await writeFile(zipPath, Buffer.concat([good, Buffer.from('x')]));
    await expect(installAvailable(r.pm, list[0]!)).rejects.toThrow(/校验和不匹配/);
    expect(r.pm.list()).toEqual([]);

    await writeFile(zipPath, good);
    const d = await installAvailable(r.pm, list[0]!);
    expect(d).toMatchObject({ name: 'notes', version: '0.3.0', enabled: false, source: { kind: 'http' } });
  });

  it('installing from an HTTP source says each step: the download with its bytes and total, then verify, unpack, copy', async () => {
    const site = await temp();
    await packPlugin(await exampleAt('0.3.0'), site);
    await writeIndex(site);
    const url = await serve(site);
    r = await rig();
    const [entry] = await listSource({ kind: 'http', location: url });
    const steps: InstallStep[] = [];
    await installAvailable(r.pm, entry!, { onProgress: (p) => steps.push(p) });
    const size = (await readFile(join(site, 'notes-0.3.0.zip'))).length;
    const downloads = steps.filter((p) => p.step === 'download');
    expect(downloads[0]).toEqual({ step: 'download', received: 0, total: size });
    expect(downloads.at(-1)).toEqual({ step: 'download', received: size, total: size });
    expect([...new Set(steps.map((p) => p.step))]).toEqual(['download', 'verify', 'unpack', 'copy']);
  });

  it('from a shared folder: read instead of download', async () => {
    const share = await temp();
    await packPlugin(await exampleAt('0.2.0'), share);
    await writeIndex(share);
    r = await rig();
    const [entry] = await listSource({ kind: 'share', location: share });
    const steps: string[] = [];
    await installAvailable(r.pm, entry!, { onProgress: (p) => steps.push(p.step) });
    expect(steps).toEqual(['read', 'verify', 'unpack', 'copy']);
  });

  it('a download fails only when nothing arrives for a while, not because it is slow; no total said when the server gives none', async () => {
    // Bytes keep coming, slower than the idle limit allows in total: it still finishes.
    let sent = 0;
    const trickle: FetchLike = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => '',
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => {
            if (sent >= 6) return { done: true };
            await new Promise((res) => setTimeout(res, 60));
            sent++;
            return { done: false, value: new Uint8Array(10) };
          },
          cancel: async () => {},
        }),
      },
    });
    const seen: InstallStep[] = [];
    const buf = await downloadPackage('http://x/p.zip', { fetch: trickle, timeoutMs: 150, onProgress: (p) => seen.push(p) });
    expect(buf.length).toBe(60);
    expect(seen.at(-1)).toEqual({ step: 'download', received: 60 });

    // Nothing for longer than the limit: it stops and says why.
    const stalled: FetchLike = async (_u, init) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => '',
      headers: { get: () => '1000' },
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_res, rej) => {
              init?.signal?.addEventListener('abort', () => rej(init.signal!.reason));
            }),
          cancel: async () => {},
        }),
      },
    });
    await expect(downloadPackage('http://x/p.zip', { fetch: stalled, timeoutMs: 100 })).rejects.toThrow('0 秒没有收到数据');
  });

  it('HTTP entries without a checksum are refused', async () => {
    const site = await temp();
    await packPlugin(EXAMPLE_PLUGIN, site);
    await writeFile(join(site, 'index.json'), JSON.stringify({ index_version: 1, plugins: [{ name: 'notes', version: '0.1.0', file: 'notes-0.1.0.zip' }] }));
    const url = await serve(site);
    r = await rig();
    const [entry] = await listSource({ kind: 'http', location: url });
    await expect(installAvailable(r.pm, entry!)).rejects.toThrow(/缺少校验和/);
  });

  it('a broken new version does not replace a working one', async () => {
    r = await rig();
    await r.pm.install(EXAMPLE_PLUGIN);
    await r.pm.enable('notes');
    const broken = await exampleAt('0.9.0');
    await writeFile(join(broken, 'server', 'index.js'), 'process.exit(2);');
    dirs.push(broken);
    await expect(r.pm.install(broken)).rejects.toThrow(/新版本 0\.9\.0 启动失败，已回退到 0\.1\.0/);
    expect(r.pm.describe('notes')).toMatchObject({ version: '0.1.0', enabled: true });
    expect(toolNames(r.rt)).toContain('notes__list_notes');
  });

  it('installs a zip the user picked', async () => {
    const out = await temp();
    const p = await packPlugin(EXAMPLE_PLUGIN, out);
    r = await rig();
    const d = await installZip(r.pm, await readFile(p.file), { kind: 'zip', location: p.file });
    expect(d).toMatchObject({ name: 'notes', version: '0.1.0', source: { kind: 'zip' } });
  });
});
