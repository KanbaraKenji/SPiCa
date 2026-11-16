import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../shared/i18n';
import { UPDATE_WORDS, UpdateService, updateErrorText } from './service';

// The main area's English, also before en.ts takes it in (shared/i18n/en.ts merges the area files).
vi.mock('../../shared/i18n/en', async (actual) => ({ EN: { ...(await actual<typeof import('../../shared/i18n/en')>()).EN, ...(await import('../../shared/i18n/en/main')).EN_MAIN } }));

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
    expect(await s.check()).toMatchObject({ status: 'error', message: '新版本文件校验不对，未安装，请稍后重试。' });
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
    expect(calls).toEqual(['https://updates.example.invalid/spica/channel.json', 'https://updates.example.invalid/spica/latest.yml']);
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
    expect(calls).toEqual(['https://channel.example.invalid/channel/channel.json', 'https://channel.example.invalid/channel/latest.yml', exe]);
    s.install();
    expect(launchInstaller.mock.calls[0]?.[0]).toMatch(/Spica-Setup-0\.2\.0-rc\.10\.exe$/);
  });

  it('the channel the build came with moved (https only): followed once, remembered, and read from there in the same check', async () => {
    const files: Record<string, string> = {
      'https://old.example.invalid/channel/channel.json': JSON.stringify({ movedTo: 'https://new.example.invalid/spica' }),
      'https://new.example.invalid/spica/channel.json': JSON.stringify({ required: '0.3.0' }),
      'https://new.example.invalid/spica/latest.yml': 'version: 0.1.0\npath: a.exe\nsha512: x\n',
    };
    let source = 'https://old.example.invalid/channel/';
    const moves: string[][] = [];
    const calls: string[] = [];
    const { s } = service(source, {
      getSource: () => ({ source, fromDeploy: true }),
      onMoved: (from, to) => {
        moves.push([from, to]);
        source = to;
      },
      fetch: async (url) => {
        calls.push(url);
        const body = files[url];
        return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? '', arrayBuffer: async () => new ArrayBuffer(0) };
      },
    });
    expect(await s.check()).toMatchObject({ status: 'latest', source: 'https://new.example.invalid/spica/' });
    expect(moves).toEqual([['https://old.example.invalid/channel/', 'https://new.example.invalid/spica/']]);
    expect(calls).toEqual(['https://old.example.invalid/channel/channel.json', 'https://new.example.invalid/spica/channel.json', 'https://new.example.invalid/spica/latest.yml']);
  });

  it('a move is not followed for a source the user typed, nor to an address that is not https', async () => {
    const onMoved = vi.fn();
    const own = sourceWith('0.1.0', { channel: { movedTo: 'https://new.example.invalid/spica/' } });
    expect((await service(own, { onMoved }).s.check()).status).toBe('latest');
    const http = sourceWith('0.1.0', { channel: { movedTo: 'http://new.example.invalid/spica/' } });
    expect((await service(http, { onMoved, getSource: () => ({ source: http, fromDeploy: true }) }).s.check()).status).toBe('latest');
    expect(onMoved).not.toHaveBeenCalled();
  });

  it('a version that must update, found at start: installed as soon as it is downloaded, without asking', async () => {
    const { s, launchInstaller } = service(sourceWith('0.3.0', { channel: { required: '0.3.0' } }));
    s.forceInstall();
    expect(s.state.forcing).toBe(true);
    expect(await s.check()).toMatchObject({ status: 'ready', required: true, forcing: true });
    expect(launchInstaller).toHaveBeenCalledTimes(1);
    // already downloaded when it is found to be forced: at once
    const again = service(sourceWith('0.3.0', { channel: { required: '0.3.0' } }));
    await again.s.check();
    expect(again.launchInstaller).not.toHaveBeenCalled();
    again.s.forceInstall();
    expect(again.launchInstaller).toHaveBeenCalledTimes(1);
  });

  it('a forced download that fails keeps forcing with the reason, so it can be tried again', async () => {
    const { s, launchInstaller } = service(sourceWith('0.3.0', { badHash: true, channel: { required: '0.3.0' } }));
    s.forceInstall();
    expect(await s.check()).toMatchObject({ status: 'error', forcing: true, message: '新版本文件校验不对，未安装，请稍后重试。' });
    expect(launchInstaller).not.toHaveBeenCalled();
  });

  it('says how far the download is, from a folder and from an address that gives its size', async () => {
    const seen: number[] = [];
    const folder = service(sourceWith('0.3.0'));
    folder.s.onChange((st) => st.progress !== undefined && seen.push(st.progress));
    await folder.s.check();
    expect(seen.at(-1)).toBe(1);
    expect(folder.s.state.progress).toBeUndefined();

    const bytes = Buffer.from('installer 0.3.0 over the web');
    const sha = createHash('sha512').update(bytes).digest('base64');
    const parts = [bytes.subarray(0, 10), bytes.subarray(10)];
    const web: number[] = [];
    const http = service('https://updates.example.invalid/spica/', {
      fetch: async (url) => {
        if (url.endsWith('/latest.yml')) return { ok: true, status: 200, text: async () => `version: 0.3.0\npath: a.exe\nsha512: ${sha}\n`, arrayBuffer: async () => new ArrayBuffer(0) };
        if (url.endsWith('/a.exe')) {
          let i = 0;
          return {
            ok: true,
            status: 200,
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
            headers: { get: (n: string) => (n === 'content-length' ? String(bytes.length) : null) },
            body: { getReader: () => ({ read: async () => (i < parts.length ? { done: false, value: new Uint8Array(parts[i++]!) } : { done: true }) }) },
          };
        }
        return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
      },
    });
    http.s.onChange((st) => st.progress !== undefined && web.push(st.progress));
    expect(await http.s.check()).toMatchObject({ status: 'ready' });
    expect(web.at(-1)).toBe(1);
  });

  it('a source with several addresses: the first that can be read is used for the update and said as the source', async () => {
    const near = join(mkdtempSync(join(tmpdir(), 'spica-near-')), 'not-there');
    const far = sourceWith('0.3.0', { notices: { announcements: [{ id: 'far', text: '从远处读的' }] } });
    const { s } = service(near, { getSource: () => ({ source: near, fromDeploy: true, sources: [near, far] }) });
    expect(await s.check()).toMatchObject({ status: 'ready', available: '0.3.0', source: far });
    expect(await s.notices()).toEqual([{ id: 'far', text: '从远处读的', level: 'info' }]);
    // none can be read: the first is the one said
    const none = service(near, { getSource: () => ({ source: near, fromDeploy: true, sources: [near, `${near}-2`] }) });
    expect(await none.s.check()).toMatchObject({ status: 'error', source: near });
  });
});

describe('UpdateService’s message and 语言', () => {
  it('says the message in the language now, and tells the listeners again when it changes', async () => {
    const { s } = service(sourceWith('0.1.0'));
    const seen: (string | undefined)[] = [];
    s.onChange((st) => seen.push(st.message));
    await s.check();
    expect(s.state.message).toBe('已是最新版本（0.1.0）。');
    setLocale('en');
    try {
      s.relabel();
      expect(seen.at(-1)).toBe('Up to date (0.1.0).');
      expect(s.state.message).toBe('Up to date (0.1.0).');
    } finally {
      setLocale('zh-CN');
    }
  });
});
describe('what a failed update says', () => {
  it('which step and what to do, in plain words; the raw error only in the log', async () => {
    expect(updateErrorText('connect', new TypeError('fetch failed'))).toBe('无法连接更新服务器，请检查网络后重试。');
    expect(updateErrorText('download', new Error('the download answered 502'))).toBe('新版本下载中断，请检查网络后重试。');
    expect(updateErrorText('write', new Error('x'))).toBe('新版本无法保存到这台电脑，请检查磁盘空间后重试。');
    expect(updateErrorText('download', Object.assign(new Error('no space'), { code: 'ENOSPC' }))).toBe('新版本无法保存到这台电脑，请检查磁盘空间后重试。');
    expect(UPDATE_WORDS.portable('0.3.0')).toBe('有新版本 0.3.0。便携版不能自动更新，请换用新版的便携版。');
    const lines: string[] = [];
    const s = new UpdateService({
      currentVersion: '0.1.0',
      packaged: true,
      portable: false,
      downloadsDir: mkdtempSync(join(tmpdir(), 'spica-dl-')),
      getSource: () => ({ source: 'https://updates.example.invalid/spica/', fromDeploy: true }),
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      launchInstaller: vi.fn(),
      log: (l) => lines.push(l),
    });
    expect(await s.check()).toMatchObject({ status: 'error', message: '无法连接更新服务器，请检查网络后重试。' });
    expect(lines.join('\n')).toContain('fetch failed');
  });
});

