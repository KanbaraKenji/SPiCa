import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginManager } from '@spica/plugins';
import { RealPluginService } from './service';

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
  function withPlugin(icon: string | undefined, write: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'spica-plugin-icon-'));
    dirs.push(dir);
    write(dir);
    const d = { name: 'demo', displayName: 'Demo', description: '', version: '1.0.0', enabled: true, mockSupported: false, skills: [], commands: [], tools: [], servers: [], issues: [], ...(icon ? { icon } : {}) };
    const m = { ...manager, list: () => [d], installDir: () => dir } as unknown as PluginManager;
    return new RealPluginService({ manager: m, root: join(dir, 'plugins'), sourcesFile: join(dir, 'sources.json'), openFolder: async () => '' });
  }

  it('goes to the page as a data: URL of the SVG (shown there only as a picture)', async () => {
    const svc = withPlugin('art/icon.svg', (dir) => {
      mkdirSync(join(dir, 'art'));
      writeFileSync(join(dir, 'art', 'icon.svg'), svg);
    });
    const p = (await svc.run({ op: 'state' })).state.plugins[0]!;
    expect(p.icon).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  });

  it('none declared, gone, or over 64 KB: no icon (the page draws the letter badge)', async () => {
    expect((await withPlugin(undefined, () => {}).run({ op: 'state' })).state.plugins[0]!.icon).toBeUndefined();
    expect((await withPlugin('icon.svg', () => {}).run({ op: 'state' })).state.plugins[0]!.icon).toBeUndefined();
    const big = withPlugin('icon.svg', (dir) => writeFileSync(join(dir, 'icon.svg'), `<svg>${' '.repeat(64 * 1024)}</svg>`));
    expect((await big.run({ op: 'state' })).state.plugins[0]!.icon).toBeUndefined();
  });
});
