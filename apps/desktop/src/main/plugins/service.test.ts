import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginManager } from '@spica/plugins';
import { RealPluginService, unreachableText } from './service';

// Only what the service touches for checking updates and opening the folder: no plugins installed.
const manager = {
  on: () => () => {},
  list: () => [],
  mock: false,
  installedVersion: () => undefined,
} as unknown as PluginManager;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function service(sources: { kind: 'share'; location: string }[] | null, openFolder = async () => '') {
  const dir = mkdtempSync(join(tmpdir(), 'spica-plugin-service-'));
  dirs.push(dir);
  const sourcesFile = join(dir, 'sources.json');
  if (sources) writeFileSync(sourcesFile, JSON.stringify(sources));
  return { svc: new RealPluginService({ manager, root: join(dir, 'plugins'), sourcesFile, openFolder }), dir };
}

describe('检查更新: what the result line says', () => {
  it('no sources: a plain notice, not a finished check', async () => {
    const r = await service(null).svc.run({ op: 'checkUpdates' });
    expect(r).toMatchObject({ ok: true, info: true, message: '没有插件来源，无法检查更新。' });
  });

  it('every source reached and nothing newer: 已是最新版本, as a result', async () => {
    const { svc, dir } = service(null);
    const share = join(dir, 'share');
    mkdirSync(share);
    writeFileSync(join(dir, 'sources.json'), JSON.stringify([{ kind: 'share', location: share }]));
    const r = await svc.run({ op: 'checkUpdates' });
    expect(r.ok).toBe(true);
    expect(r.info).toBeUndefined();
    expect(r.message).toBe('已是最新版本。');
  });

  it('some sources not reached: never 已是最新版本; the reached and the failed said apart, plain', async () => {
    const { svc, dir } = service(null);
    const share = join(dir, 'share');
    mkdirSync(share);
    writeFileSync(join(dir, 'sources.json'), JSON.stringify([{ kind: 'share', location: share }, { kind: 'share', location: join(dir, 'missing') }]));
    const r = await svc.run({ op: 'checkUpdates' });
    expect(r).toMatchObject({ ok: true, info: true, message: '已检查 1 个插件来源：没有可用更新；1 个连接失败。' });
  });

  it('no source reached: a failure', async () => {
    const { svc, dir } = service(null);
    writeFileSync(join(dir, 'sources.json'), JSON.stringify([{ kind: 'share', location: join(dir, 'missing') }]));
    const r = await svc.run({ op: 'checkUpdates' });
    expect(r).toMatchObject({ ok: false, message: '1 个插件来源连接失败，无法检查更新。' });
  });
});

describe('打开插件文件夹', () => {
  it('when Explorer cannot open it, that is a failure, not a success', async () => {
    const r = await service(null, async () => '拒绝访问').svc.run({ op: 'openRoot' });
    expect(r).toMatchObject({ ok: false, message: '无法打开文件夹：拒绝访问' });
  });

  it('opened: nothing to say', async () => {
    const r = await service(null).svc.run({ op: 'openRoot' });
    expect(r.ok).toBe(true);
    expect(r.message).toBeUndefined();
  });
});

describe('a plugin’s own icon', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#4f7cff"/></svg>';
  function withPlugin(icon: string | { light: string; dark: string } | undefined, write: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'spica-plugin-icon-'));
    dirs.push(dir);
    write(dir);
    const d = { name: 'demo', displayName: 'Demo', description: '', version: '1.0.0', enabled: true, mockSupported: false, skills: [], commands: [], tools: [], servers: [], issues: [], ...(icon ? { icon: typeof icon === 'string' ? { light: icon, dark: icon } : icon } : {}) };
    const m = { ...manager, list: () => [d], installDir: () => dir } as unknown as PluginManager;
    return new RealPluginService({ manager: m, root: join(dir, 'plugins'), sourcesFile: join(dir, 'sources.json'), openFolder: async () => '' });
  }

  it('goes to the page as a data: URL of the SVG (shown there only as a picture)', async () => {
    const svc = withPlugin('art/icon.svg', (dir) => {
      mkdirSync(join(dir, 'art'));
      writeFileSync(join(dir, 'art', 'icon.svg'), svg);
    });
    const p = (await svc.run({ op: 'state' })).state.plugins[0]!;
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    expect(p.icon).toEqual({ light: url, dark: url });
  });

  it('one for each skin: both go, each its own picture; one of them unreadable: none (the letter badge)', async () => {
    const dark = svg.replace('#4f7cff', '#1d2b55');
    const svc = withPlugin({ light: 'icon-light.svg', dark: 'icon-dark.svg' }, (dir) => {
      writeFileSync(join(dir, 'icon-light.svg'), svg);
      writeFileSync(join(dir, 'icon-dark.svg'), dark);
    });
    expect((await svc.run({ op: 'state' })).state.plugins[0]!.icon).toEqual({
      light: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      dark: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(dark)}`,
    });
    const half = withPlugin({ light: 'icon-light.svg', dark: 'icon-dark.svg' }, (dir) => writeFileSync(join(dir, 'icon-light.svg'), svg));
    expect((await half.run({ op: 'state' })).state.plugins[0]!.icon).toBeUndefined();
  });

  it('none declared, gone, or over 64 KB: no icon (the page draws the letter badge)', async () => {
    expect((await withPlugin(undefined, () => {}).run({ op: 'state' })).state.plugins[0]!.icon).toBeUndefined();
    expect((await withPlugin('icon.svg', () => {}).run({ op: 'state' })).state.plugins[0]!.icon).toBeUndefined();
    const big = withPlugin('icon.svg', (dir) => writeFileSync(join(dir, 'icon.svg'), `<svg>${' '.repeat(64 * 1024)}</svg>`));
    expect((await big.run({ op: 'state' })).state.plugins[0]!.icon).toBeUndefined();
  });
});

describe('the one box: looking at a typed location, installing what is there', () => {
  /** A manager that knows one plugin folder (anything with a manifest.json reads as "demo" 1.2.0) and records installs. */
  function rigged() {
    const dir = mkdtempSync(join(tmpdir(), 'spica-plugin-find-'));
    dirs.push(dir);
    const installed = new Map<string, string>();
    const enabled = new Set<string>();
    const calls: string[] = [];
    const describe_ = (name: string) => ({ name, displayName: name, description: '', version: installed.get(name)!, enabled: enabled.has(name), mockSupported: false, skills: [], commands: [], tools: [], servers: [], issues: [] });
    const m = {
      ...manager,
      appName: 'Spica',
      list: () => [...installed.keys()].map(describe_),
      installedVersion: (n: string) => installed.get(n),
      installDir: () => dir,
      describe: describe_,
      check: async (where: string) => ({ root: where, manifest: { name: 'demo', displayName: 'Demo', version: '1.2.0', description: 'A demo.' }, skills: [], commands: [], servers: [], hooks: [], views: [{ title: 'Board' }], issues: [] }),
      install: async (where: string, _src: unknown, opts?: { onProgress?: (p: { step: string }) => void }) => {
        calls.push(`install ${where}`);
        opts?.onProgress?.({ step: 'copy' });
        installed.set('demo', '1.2.0');
        return describe_('demo');
      },
      enable: async (n: string) => {
        enabled.add(n);
        return describe_(n);
      },
    } as unknown as PluginManager;
    const progress: unknown[] = [];
    const sourcesFile = join(dir, 'sources.json');
    const svc = new RealPluginService({ manager: m, root: join(dir, 'plugins'), sourcesFile, openFolder: async () => '', onProgress: (p) => progress.push(p) });
    return { dir, svc, calls, progress, sourcesFile };
  }

  it('a path that is not there: said as a failure (the old install from a path said it as a success)', async () => {
    const { svc, dir } = rigged();
    const r = await svc.run({ op: 'install', location: join(dir, 'nowhere') });
    expect(r).toMatchObject({ ok: false, message: '找不到该文件夹或文件。' });
    const f = await svc.run({ op: 'find', location: join(dir, 'nowhere') });
    expect(f.ok).toBe(true);
    expect(f.state.found).toEqual({ location: join(dir, 'nowhere'), packages: [], error: '找不到该文件夹或文件。', reason: 'missing' });
  });

  it('a folder with neither manifest.json nor index.json: nothing to install, said so', async () => {
    const { svc, dir } = rigged();
    mkdirSync(join(dir, 'empty'));
    expect((await svc.run({ op: 'find', location: join(dir, 'empty') })).state.found).toMatchObject({ error: '该文件夹中没有插件（缺少 manifest.json 或 index.json）。', reason: 'empty' });
    // A file that is not a package at all, and a .zip that is not a plugin package.
    writeFileSync(join(dir, 'notes.txt'), 'x');
    expect((await svc.run({ op: 'find', location: join(dir, 'notes.txt') })).state.found?.reason).toBe('empty');
    writeFileSync(join(dir, 'broken.zip'), 'not a zip');
    expect((await svc.run({ op: 'find', location: join(dir, 'broken.zip') })).state.found?.reason).toBe('unreadable');
    // An address that does not answer.
    const gone = await svc.run({ op: 'find', location: 'http://127.0.0.1:9/index.json' });
    expect(gone.state.found).toMatchObject({ reason: 'unreachable' });
    expect(gone.state.found?.error).toBe('服务器没有响应。');
  });

  it('a plugin folder (in quotes, as Explorer copies it) is listed with what it says, installed only when asked, with each step under the page’s job, then turned on', async () => {
    const { svc, dir, calls, progress } = rigged();
    const folder = join(dir, 'demo');
    mkdirSync(folder);
    writeFileSync(join(folder, 'manifest.json'), '{}');
    const f = await svc.run({ op: 'find', location: `"${folder}"` });
    expect(f.state.found?.packages).toEqual([{ key: `found:${folder}`, name: 'demo', displayName: 'Demo', version: '1.2.0', description: 'A demo.', location: folder, kind: 'folder', skills: [], commands: [], pages: ['Board'] }]);
    expect(calls).toEqual([]);
    const r = await svc.run({ op: 'installAvailable', key: `found:${folder}`, job: 'j1' });
    expect(r).toMatchObject({ ok: true, message: '已安装「demo」1.2.0。' });
    expect(calls).toEqual([`install ${folder}`]);
    expect(progress).toEqual([{ job: 'j1', step: 'copy' }, { job: 'j1', step: 'start' }]);
    // Listed again, it now says which version is installed.
    expect(r.state.found?.packages[0]?.installed).toBe('1.2.0');
  });

  it('a shared folder with an index is listed but not remembered; installing from it remembers it (未安装 lists it from then on)', async () => {
    const { svc, dir, sourcesFile } = rigged();
    const share = join(dir, 'share');
    mkdirSync(join(share, 'demo'), { recursive: true });
    writeFileSync(join(share, 'index.json'), JSON.stringify({ index_version: 1, plugins: [{ name: 'demo', version: '1.2.0', file: 'demo/', description: 'A demo.' }] }));
    const f = await svc.run({ op: 'find', location: share });
    expect(f.state.found?.packages.map((p) => [p.name, p.version, p.kind])).toEqual([['demo', '1.2.0', 'share']]);
    expect(existsSync(sourcesFile)).toBe(false);
    const key = f.state.found!.packages[0]!.key;
    expect((await svc.run({ op: 'installAvailable', key })).ok).toBe(true);
    expect(JSON.parse(readFileSync(sourcesFile, 'utf8'))).toEqual([{ kind: 'share', location: share }]);
  });

  it('未安装: the remembered sources listed again, the installed plugins left out; a source not reached is noted', async () => {
    const { svc, dir, sourcesFile } = rigged();
    const share = join(dir, 'share');
    mkdirSync(share);
    writeFileSync(join(share, 'index.json'), JSON.stringify({ index_version: 1, plugins: [{ name: 'other', version: '0.3.0', file: 'other-0.3.0.zip', description: 'Another.' }, { name: 'other', version: '0.2.0', file: 'other-0.2.0.zip' }] }));
    writeFileSync(sourcesFile, JSON.stringify([{ kind: 'share', location: share }, { kind: 'share', location: join(dir, 'gone') }]));
    const r = await svc.run({ op: 'refreshSources' });
    expect(r.state.available?.map((a) => [a.name, a.version, a.description])).toEqual([['other', '0.3.0', 'Another.']]);
    expect(r.state.sourceErrors).toEqual([join(dir, 'gone')]);
  });
});

describe('why an address did not answer, in words', () => {
  it('no answer, an HTTP status, a timeout', () => {
    expect(unreachableText('无法连接插件源 http://x/index.json（fetch failed）。')).toBe('服务器没有响应。');
    expect(unreachableText('无法连接插件源 http://x/index.json（HTTP 404）。')).toBe('服务器返回 HTTP 404。');
    expect(unreachableText('无法连接插件源 http://x/index.json（The operation was aborted due to timeout）。')).toBe('连接超时。');
  });
});
