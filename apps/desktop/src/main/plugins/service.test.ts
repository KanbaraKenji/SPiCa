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
