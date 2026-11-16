import { describe, expect, it } from 'vitest';
import { validateManifest } from './manifest.ts';
import { checkConfigValue, configForServer, missingConfig, parseUserConfig, scrubSecrets, type UserConfigField } from './user-config.ts';

const base = { manifest_version: 1, name: 'tickets', version: '1.0.0', description: 'd', author: 'a', license: 'MIT', compatibility: { spica: '*' } };
const read = (user_config: unknown) => validateManifest({ ...base, user_config });
const field = (over: Partial<UserConfigField>): UserConfigField => ({ key: 'k', type: 'text', title: 'K', required: false, ...over });

describe('user_config in the manifest', () => {
  it('reads the eight kinds in the order written; no user_config, no form', () => {
    const r = read({
      server_url: { type: 'url', title: '服务器地址', placeholder: 'https://example.com', required: true },
      password: { type: 'password', title: '密码' },
      page_size: { type: 'number', title: '每页条数', default: 20, min: 1, max: 100 },
      weekly: { type: 'toggle', title: '每周汇总', default: false },
      mode: { type: 'select', title: '模式', options: ['日报', '周报'], default: '日报' },
      save_to: { type: 'folder', title: '保存到' },
      template: { type: 'file', title: '模板' },
      account: { type: 'text', title: '账号（工号）' },
    });
    expect(r.issues).toEqual([]);
    expect(r.manifest?.userConfig?.map((f) => `${f.key}:${f.type}`)).toEqual(['server_url:url', 'password:password', 'page_size:number', 'weekly:toggle', 'mode:select', 'save_to:folder', 'template:file', 'account:text']);
    expect(r.manifest?.userConfig?.[0]).toMatchObject({ required: true, placeholder: 'https://example.com' });
    expect(validateManifest(base).manifest).not.toHaveProperty('userConfig');
  });

  it('an unknown type is an error naming every type, and points to password for a secret', () => {
    const r = read({ password: { type: 'secret', title: '密码' } });
    expect(r.manifest).toBeUndefined();
    expect(r.issues).toEqual([
      { where: 'manifest.json · user_config.password.type', severity: 'error', message: '没有 "secret" 这种类型，可以写 text、password、number、toggle、select、folder、file、url；密码写 password。' },
    ]);
  });

  it("MCPB's spellings are read as ours, with a note (never an error)", () => {
    const r = read({ password: { type: 'string', title: '密码', sensitive: true }, on: { type: 'boolean', title: '开' }, dir: { type: 'directory', title: '目录', description: '放附件' } });
    expect(r.manifest?.userConfig?.map((f) => f.type)).toEqual(['password', 'toggle', 'folder']);
    expect(r.manifest?.userConfig?.[2]?.description).toBe('放附件');
    expect(r.issues.map((i) => [i.where, i.severity, i.message])).toEqual([
      ['manifest.json · user_config.password.type', 'warning', '按 password 读了（你写的是 string + sensitive），这里的写法是 "type": "password"。'],
      ['manifest.json · user_config.on.type', 'warning', '按 toggle 读了（你写的是 boolean），这里的写法是 "type": "toggle"。'],
      ['manifest.json · user_config.dir.type', 'warning', '按 folder 读了（你写的是 directory），这里的写法是 "type": "folder"。'],
    ]);
  });

  it('a password only goes up: sensitive false on a password, sensitive on a number, options on a string are errors', () => {
    const msgs = (spec: unknown) => read({ k: spec }).issues.filter((i) => i.severity === 'error').map((i) => i.message);
    expect(msgs({ type: 'password', title: 'P', sensitive: false })).toEqual(['password 不能写 sensitive: false；不是密码就写 "type": "text"。']);
    expect(msgs({ type: 'number', title: 'N', sensitive: true })).toEqual(['number 不能带 sensitive；密码写 "type": "password"。']);
    expect(msgs({ type: 'string', title: 'S', options: ['a'] })).toEqual(['只有 select 能带 options；要让人从几项里选，写 "type": "select"。']);
    expect(msgs({ type: 'select', title: 'S' })).toEqual(['select 要写 options，例如 ["日报", "周报"]。']);
    expect(msgs({ type: 'password', title: 'P', default: 'x' })).toEqual(['密码不能有默认值（会写进插件包）。']);
    expect(msgs({ type: 'number', title: 'N', min: 5, default: 1 })).toEqual(['默认值不合格：不能小于 5']);
    expect(msgs({ type: 'select', title: 'S', options: ['a'], default: 'b' })).toEqual(['默认值不合格：请从 a 里选']);
    expect(read({ 'Server-URL': { type: 'text', title: 'x' } }).issues[0]?.message).toMatch(/^键名「Server-URL」不合格/);
    expect(msgs({ type: 'text' })).toEqual(['缺少 title（表单上这一格的名字），例如 "服务器地址"。']);
  });

  it('a key named like a secret on a field that is not a password gets a warning (by segment, never an error); unknown properties too', () => {
    const r = read({ api_key: { type: 'text', title: 'Key' }, access_token: { type: 'text', title: 'T' }, keyboard: { type: 'text', title: 'K', colour: 'red' } });
    expect(r.manifest?.userConfig).toHaveLength(3);
    expect(r.issues.map((i) => `${i.severity} ${i.where}`)).toEqual([
      'warning manifest.json · user_config.api_key.type',
      'warning manifest.json · user_config.access_token.type',
      'warning manifest.json · user_config.keyboard.colour',
    ]);
  });

  it('parseUserConfig: anything but an object is an error', () => {
    const errs: string[] = [];
    parseUserConfig([], (p, m) => errs.push(`${p}: ${m}`), () => undefined);
    expect(errs[0]).toMatch(/^user_config: 「user_config」须为对象/);
  });
});

describe('values', () => {
  it('a url gets https:// when written without; anything but http(s) is refused', () => {
    const url = field({ type: 'url' });
    expect(checkConfigValue(url, ' tickets.example.com/api ')).toEqual({ ok: true, value: 'https://tickets.example.com/api' });
    expect(checkConfigValue(url, 'http://intranet:8080')).toEqual({ ok: true, value: 'http://intranet:8080' });
    expect(checkConfigValue(url, 'ftp://x')).toEqual({ ok: false, message: '请输入以 https:// 开头的网址' });
    expect(checkConfigValue(url, '')).toEqual({ ok: true, value: null });
  });

  it('numbers from text, in range; toggles only true / false; a password kept as typed', () => {
    const n = field({ type: 'number', min: 1, max: 100 });
    expect(checkConfigValue(n, '20')).toEqual({ ok: true, value: 20 });
    expect(checkConfigValue(n, 'abc')).toEqual({ ok: false, message: '请输入数字' });
    expect(checkConfigValue(n, 0)).toEqual({ ok: false, message: '不能小于 1' });
    expect(checkConfigValue(field({ type: 'toggle' }), 'yes')).toEqual({ ok: false, message: '只能是开或关' });
    expect(checkConfigValue(field({ type: 'password' }), ' p w ')).toEqual({ ok: true, value: ' p w ' });
  });

  it('every declared key reaches the server: stored, else default, else null; a stored value that no longer fits is as not filled in', () => {
    const fields = [field({ key: 'url', type: 'url', required: true }), field({ key: 'size', type: 'number', default: 20, max: 50 }), field({ key: 'note' })];
    expect(configForServer(fields, {})).toEqual({ url: null, size: 20, note: null });
    expect(configForServer(fields, { url: 'https://a.example.com', size: 80, other: 'x' })).toEqual({ url: 'https://a.example.com', size: 20, note: null });
    expect(missingConfig(fields, {})).toEqual(['url']);
    expect(missingConfig(fields, { url: 'https://a.example.com' })).toEqual([]);
  });

  it('passwords out of log lines: 6 characters or more anywhere, shorter ones only standing alone', () => {
    expect(scrubSecrets('login with hunter22 failed (hunter22x)', ['hunter22'])).toBe('login with [redacted] failed ([redacted]x)');
    expect(scrubSecrets('pin=1234; code 12345; a1234b', ['1234'])).toBe('pin=[redacted]; code 12345; a1234b');
  });
});
