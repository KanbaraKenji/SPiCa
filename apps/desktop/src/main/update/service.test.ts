import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { UpdateService } from './service';

function sourceWith(version: string, opts: { badHash?: boolean; notices?: unknown; channel?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'spica-src-'));
  const file = `Spica-Setup-${version}.exe`;
  const bytes = Buffer.from(`installer ${version}`);
  writeFileSync(join(dir, file), bytes);
  const sha = opts.badHash ? 'nope' : createHash('sha512').update(bytes).digest('base64');
  writeFileSync(join(dir, 'latest.yml'), `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: ${sha}\npath: ${file}\nsha512: ${sha}\n`);
  if (opts.notices) writeFileSync(join(dir, 'announcements.json'), JSON.stringify(opts.notices));
  if (opts.channel !== undefined) writeFileSync(join(dir, 'channel.json'), typeof opts.channel === 'string' ? opts.channel : JSON.stringify(opts.channel));
  return dir;
}

function service(source: string, over: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const launchInstaller = vi.fn();
  const s = new UpdateService({
    currentVersion: '0.1.0',
    packaged: true,
    portable: false,
    downloadsDir: mkdtempSync(join(tmpdir(), 'spica-dl-')),
    getSource: () => ({ source, fromDeploy: false }),
    fetch: () => Promise.reject(new Error('no network in tests')),
    launchInstaller,
    ...over,
  });
  return { s, launchInstaller };
}

describe('UpdateService', () => {
  it('downloads a newer version from a folder, checks it and installs on request', async () => {
    const { s, launchInstaller } = service(sourceWith('0.1.1'));
    const st = await s.check();
    expect(st).toMatchObject({ status: 'ready', available: '0.1.1' });
    expect(s.install()).toBe(true);
    expect(launchInstaller.mock.calls[0]?.[0]).toMatch(/Spica-Setup-0\.1\.1\.exe$/);
  });

  it('says it is up to date', async () => {
    const { s } = service(sourceWith('0.1.0'));
    expect(await s.check()).toMatchObject({ status: 'latest', message: '已是最新版本（0.1.0）。' });
  });

  it('refuses an installer whose checksum does not match', async () => {
    const { s, launchInstaller } = service(sourceWith('0.2.0', { badHash: true }));
    expect(await s.check()).toMatchObject({ status: 'error', message: '安装包校验失败，未安装。' });
    expect(s.install()).toBe(false);
    expect(launchInstaller).not.toHaveBeenCalled();
  });

  it('only tells a portable copy that a new version exists', async () => {
    const { s } = service(sourceWith('0.3.0'), { portable: true });
    expect(await s.check()).toMatchObject({ status: 'manual', available: '0.3.0' });
  });

  it('is off without a source and reads announcements from the same place', async () => {
    expect((await service('').s.check()).status).toBe('off');
    const { s } = service(sourceWith('0.1.0', { notices: { announcements: [{ id: 'm1', text: '周六维护' }] } }));
    expect(await s.notices()).toEqual([{ id: 'm1', text: '周六维护', level: 'info' }]);
    expect(await service(sourceWith('0.1.0')).s.notices()).toEqual([]);
  });

  it('talks to an http source through the given fetch', async () => {
    const calls: string[] = [];
    const { s } = service('https://updates.example.invalid/spica', {
      fetch: async (url) => {
        calls.push(url);
        return { ok: true, status: 200, text: async () => 'version: 0.1.0\npath: a.exe\nsha512: x', arrayBuffer: async () => new ArrayBuffer(0) };
      },
    });
    expect((await s.check()).status).toBe('latest');
    expect(calls).toEqual(['https://updates.example.invalid/spica/latest.yml']);
  });

  it('channel.json marks versions below "required" as must-update; the mark can be taken back while it waits', async () => {
    const dir = sourceWith('0.3.0', { channel: { required: '0.2.0' } });
    const { s } = service(dir);
    expect(await s.check()).toMatchObject({ status: 'ready', available: '0.3.0', required: true });
    writeFileSync(join(dir, 'channel.json'), '{}');
    expect(await s.check()).toMatchObject({ status: 'ready', required: false });
    writeFileSync(join(dir, 'channel.json'), JSON.stringify({ required: 'v0.3.0' }));
    expect(await s.check()).toMatchObject({ status: 'ready', required: true });
  });

  it('not required: at or above the mark, no channel.json, or one that cannot be read', async () => {
    expect(await service(sourceWith('0.3.0', { channel: { required: '0.1.0' } })).s.check()).toMatchObject({ status: 'ready', required: false });
    expect(await service(sourceWith('0.3.0')).s.check()).toMatchObject({ status: 'ready', required: false });
    expect(await service(sourceWith('0.3.0', { channel: '{ nope' })).s.check()).toMatchObject({ status: 'ready', required: false });
    expect(await service(sourceWith('0.3.0', { channel: { required: 'soon' } })).s.check()).toMatchObject({ status: 'ready', required: false });
    expect(await service(sourceWith('0.3.0', { channel: { required: '0.2.0' } }), { portable: true }).s.check()).toMatchObject({ status: 'manual', required: true });
  });

  it('downloads the installer from the full address latest.yml gives (the official channel)', async () => {
    const bytes = Buffer.from('installer 0.2.0-rc.10');
    const sha = createHash('sha512').update(bytes).digest('base64');
    const exe = 'https://downloads.example.invalid/v0.2.0-rc.10/Spica-Setup-0.2.0-rc.10.exe';
    const calls: string[] = [];
    const reply = (body: string | Buffer, status = 200) => ({ ok: status < 400, status, text: async () => String(body), arrayBuffer: async () => new Uint8Array(Buffer.from(body)).buffer });
    const { s, launchInstaller } = service('https://channel.example.invalid/channel/', {
      currentVersion: '0.2.0-rc.9',
      fetch: async (url) => {
        calls.push(url);
        if (url.endsWith('/latest.yml')) return reply(`version: 0.2.0-rc.10\npath: ${exe}\nsha512: ${sha}\n`);
        if (url === exe) return reply(bytes);
        return reply('', 404);
      },
    });
    expect(await s.check()).toMatchObject({ status: 'ready', available: '0.2.0-rc.10', required: false });
    expect(calls).toEqual(['https://channel.example.invalid/channel/latest.yml', 'https://channel.example.invalid/channel/channel.json', exe]);
    s.install();
    expect(launchInstaller.mock.calls[0]?.[0]).toMatch(/Spica-Setup-0\.2\.0-rc\.10\.exe$/);
  });
});
