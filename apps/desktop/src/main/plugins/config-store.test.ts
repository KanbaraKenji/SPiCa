import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UserConfigField } from '@spica/plugins/user-config';
import type { SecretBox } from '../providers/store';
import { deployPluginConfig, PluginConfigError, PluginConfigStore } from './config-store';

const box: SecretBox = {
  available: () => true,
  encrypt: (s) => Buffer.from(`sealed:${s}`).toString('base64'),
  decrypt: (s) => Buffer.from(s, 'base64').toString().replace(/^sealed:/, ''),
};

const FIELDS: UserConfigField[] = [
  { key: 'server_url', type: 'url', title: '服务器地址', required: true },
  { key: 'password', type: 'password', title: '密码', required: true },
  { key: 'page_size', type: 'number', title: '每页条数', min: 1, max: 100, required: false },
];
const SECRET = 'correct-horse-battery';

describe('PluginConfigStore', () => {
  it('seals passwords, keeps the rest as typed (checked); the file never holds a password in the clear', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-pcfg-'));
    const s = new PluginConfigStore(dir, box);
    s.save('tix', 'share:\\\\fs\\p', FIELDS, { server_url: 'tickets.example.com', password: SECRET, page_size: '20' });
    expect(readFileSync(join(dir, 'plugin-config.json'), 'utf8')).not.toContain(SECRET);
    expect(new PluginConfigStore(dir, box).input('tix')).toEqual({ values: { server_url: 'https://tickets.example.com', password: SECRET, page_size: 20 }, source: 'share:\\\\fs\\p' });
  });

  it('a password left empty keeps the saved one; another field left empty is cleared; keys not sent stay', () => {
    const s = new PluginConfigStore(mkdtempSync(join(tmpdir(), 'spica-pcfg-')), box);
    s.save('tix', '', FIELDS, { server_url: 'https://a.example.com', password: SECRET, page_size: 5 });
    s.save('tix', '', FIELDS, { password: '', page_size: null });
    expect(s.input('tix')?.values).toEqual({ server_url: 'https://a.example.com', password: SECRET });
  });

  it('a value that does not fit stops the save, by key, and nothing is saved', () => {
    const s = new PluginConfigStore(mkdtempSync(join(tmpdir(), 'spica-pcfg-')), box);
    let err: unknown;
    try {
      s.save('tix', '', FIELDS, { server_url: 'ftp://x', page_size: 0 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PluginConfigError);
    expect((err as PluginConfigError).fields).toEqual({ server_url: '请输入以 https:// 开头的网址', page_size: '不能小于 1' });
    expect(s.input('tix')).toBeNull();
  });

  it('no sealing on this computer: a password is not saved (never in the clear)', () => {
    const s = new PluginConfigStore(mkdtempSync(join(tmpdir(), 'spica-pcfg-')), { ...box, available: () => false });
    expect(() => s.save('tix', '', FIELDS, { password: SECRET })).toThrow('无法加密保存密码，未保存。');
  });

  it('saved for another source: the passwords go, the rest stays', () => {
    const s = new PluginConfigStore(mkdtempSync(join(tmpdir(), 'spica-pcfg-')), box);
    s.save('tix', 'folder:A', FIELDS, { server_url: 'https://a.example.com', password: SECRET });
    s.save('tix', 'folder:B', FIELDS, { page_size: 3 });
    expect(s.input('tix')).toEqual({ values: { server_url: 'https://a.example.com', page_size: 3 }, source: 'folder:B' });
  });

  it("the packaging's values: a locked one wins and is marked; another fills in only what the person has not", () => {
    const s = new PluginConfigStore(mkdtempSync(join(tmpdir(), 'spica-pcfg-')), box);
    s.save('tix', '', FIELDS, { server_url: 'https://mine.example.com', page_size: 7 });
    const deploy = deployPluginConfig({ tix: { server_url: { value: 'https://gw.example.com', locked: true }, page_size: { value: 50 } }, other: { mode: { value: '周报' } }, bad: { x: { value: { nested: 1 } } } });
    expect(s.input('tix', deploy)).toEqual({ values: { server_url: 'https://gw.example.com', page_size: 7 }, deploy: ['server_url'], locked: ['server_url'], source: '' });
    expect(s.inputs(deploy)).toMatchObject({ other: { values: { mode: '周报' }, deploy: ['mode'] } });
    expect(s.inputs(deploy)).not.toHaveProperty('bad');
    // locked keys are not the person's to change
    s.save('tix', '', FIELDS, { server_url: 'https://other.example.com' }, ['server_url']);
    expect(s.input('tix')?.values.server_url).toBe('https://mine.example.com');
  });

  it('remove forgets a plugin', () => {
    const s = new PluginConfigStore(mkdtempSync(join(tmpdir(), 'spica-pcfg-')), box);
    s.save('tix', '', FIELDS, { page_size: 1 });
    s.remove('tix');
    expect(s.input('tix')).toBeNull();
  });
});
