import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { keyMaskParts, keyMaskText } from '@spica/protocol';
import { emptyDraft } from '../../shared/providers';
import { ProviderStore, type SecretBox } from './store';
import { createFakeTester } from './tester';

const box: SecretBox = {
  available: () => true,
  encrypt: (s) => Buffer.from(`sealed:${s}`).toString('base64'),
  decrypt: (s) => Buffer.from(s, 'base64').toString().replace(/^sealed:/, ''),
};

const draft = { ...emptyDraft('openai'), name: '测试网关', baseUrl: 'https://api.example.com/v1', model: 'model-a', contextWindow: 128_000, secret: 'sk-123' };

describe('ProviderStore', () => {
  it('saves, encrypts the secret, and never returns it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-prov-'));
    const store = new ProviderStore(dir, box);
    const view = store.save(draft);
    expect(view).toMatchObject({ name: '测试网关', hasSecret: true, isDefault: true });
    expect(JSON.stringify(view)).not.toContain('sk-123');
    const file = readFileSync(join(dir, 'providers.json'), 'utf8');
    expect(file).not.toContain('sk-123');
    expect(store.resolved()[0]?.secret).toBe('sk-123');
    // Reloads from disk.
    expect(new ProviderStore(dir, box).list()).toHaveLength(1);
  });

  it('names the connections whose saved key cannot be opened here (sealed in another settings folder)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-prov-'));
    const saved = new ProviderStore(dir, box).save(draft);
    expect(new ProviderStore(dir, box).unreadableKeys()).toEqual([]);
    const elsewhere = new ProviderStore(dir, { ...box, decrypt: () => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.'); } });
    expect(elsewhere.unreadableKeys()).toEqual([saved.id]);
    expect(elsewhere.resolved()).toEqual([]);
    // Saving the key again in this folder makes it usable.
    elsewhere.save({ ...draft, id: saved.id, secret: 'sk-456' });
    expect(new ProviderStore(dir, box).unreadableKeys()).toEqual([]);
  });

  it('keeps the saved secret when the draft leaves it empty', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    const v = store.save(draft);
    store.save({ ...draft, id: v.id, secret: undefined, model: 'model-b' });
    expect(store.resolved()[0]).toMatchObject({ model: 'model-b', secret: 'sk-123' });
  });

  it('refuses incomplete forms in plain words', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    expect(() => store.save({ ...draft, baseUrl: 'api.example.com' })).toThrow('地址须以 http:// 或 https:// 开头');
    expect(() => store.save({ ...emptyDraft('wso2'), name: 'w', baseUrl: 'https://g/v1', model: 'm', secret: 's' })).toThrow('请填写取 token 地址');
  });

  it('a version 1 file becomes connections: same ids, model and strong model ticked, the default where it was', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-prov-'));
    const sealed = box.encrypt('sk-old-00000000000000000009f3a');
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify({
        defaultId: 'p-b',
        items: [
          { id: 'p-a', kind: 'openai', name: 'A', baseUrl: 'https://a.example.com/v1', model: 'm-a', strongModel: '', tokenUrl: '', clientId: '', scope: '', maxConcurrent: null, requestsPerMinute: null, secret: sealed },
          { id: 'p-b', kind: 'openai', name: 'B', baseUrl: 'https://b.example.com/v1', model: 'm-b', strongModel: 'm-b-pro', contextWindow: 64000, tokenUrl: '', clientId: '', scope: '', maxConcurrent: 2, requestsPerMinute: null, secret: sealed },
        ],
      }),
    );
    const store = new ProviderStore(dir, box);
    const [a, b] = store.list();
    expect(a).toMatchObject({ id: 'p-a', models: [{ id: 'm-a', contextWindow: null }], keyMask: 'sk-o****9f3a', hasSecret: true });
    expect(b).toMatchObject({ id: 'p-b', maxConcurrent: 2, models: [{ id: 'm-b', contextWindow: 64000 }, { id: 'm-b-pro', contextWindow: null }] });
    expect(store.defaultRef()).toEqual({ connectionId: 'p-b', model: 'm-b' });
    expect(store.strongRef()).toEqual({ connectionId: 'p-b', model: 'm-b-pro' });
    expect(store.secretOf('p-a')).toBe('sk-old-00000000000000000009f3a');
    // Rewritten as version 2 once; reading it again gives the same.
    expect(JSON.parse(readFileSync(join(dir, 'providers.json'), 'utf8')).version).toBe(2);
    expect(new ProviderStore(dir, box).list()).toEqual(store.list());
    // A model without a window still has to get one before the one-model form saves it.
    expect(() => store.save({ ...draft, id: 'p-a', contextWindow: null })).toThrow('请填写上下文上限');
  });

  it('a version 1 key moved before the app was ready (the key store not usable yet): its first and last characters come back once ready', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-prov-'));
    const sealed = box.encrypt('sk-fake0123456789abcdefghijk3f9a');
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify({ defaultId: 'p-a', items: [{ id: 'p-a', kind: 'openai', name: 'A', baseUrl: 'https://a.example.com/v1', model: 'm-a', strongModel: '', tokenUrl: '', clientId: '', scope: '', maxConcurrent: null, requestsPerMinute: null, secret: sealed }] }),
    );
    let ready = false;
    const early: SecretBox = { ...box, available: () => ready, decrypt: (x) => (ready ? box.decrypt(x) : (() => { throw new Error('safeStorage cannot be used before the app is ready'); })()) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new ProviderStore(dir, early);
    // Moved, but nothing to show yet; said in the log, without the key.
    expect(store.list()[0]).toMatchObject({ id: 'p-a', keyMask: '****', hasSecret: true });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).not.toContain('sk-fake');
    warn.mockRestore();
    ready = true;
    expect(store.fillKeyMasks()).toBe(1);
    expect(store.list()[0]!.keyMask).toBe('sk-f****3f9a');
    // Written back: the next start shows it at once, with no key store needed.
    const saved = JSON.parse(readFileSync(join(dir, 'providers.json'), 'utf8'));
    expect(saved.items[0].keys[0]).toMatchObject({ head: 'sk-f', tail: '3f9a' });
    expect(new ProviderStore(dir, { ...early, decrypt: () => { throw new Error('not again'); } }).list()[0]!.keyMask).toBe('sk-f****3f9a');
  });

  it('a version 2 file already written with empty first and last characters (moved by 0.1.0-rc.3 before this fix) is mended on the next start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-prov-'));
    const sealed = box.encrypt('sk-fake0123456789abcdefghijk3f9a');
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify({
        version: 2,
        items: [{ id: 'p-a', kind: 'openai', name: 'A', baseUrl: 'https://a.example.com/v1', tokenUrl: '', clientId: '', scope: '', maxConcurrent: null, requestsPerMinute: null, catalogId: null, models: [{ id: 'm-a', contextWindow: 128000, contextFrom: 'user' }], keys: [{ sealed, tail: '', head: '' }] }],
        default: { connectionId: 'p-a', model: 'm-a' },
        strong: null,
      }),
    );
    const store = new ProviderStore(dir, box);
    expect(store.list()[0]!.keyMask).toBe('****');
    expect(store.fillKeyMasks()).toBe(1);
    expect(store.list()[0]!.keyMask).toBe('sk-f****3f9a');
    // Nothing left to fill: no second write.
    expect(store.fillKeyMasks()).toBe(0);
  });

  it('one connection, several models; unticking the default model moves the pointer within the connection', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    const v = store.save({ ...draft, models: [{ id: 'flash', contextWindow: 1000, contextFrom: 'catalog' }, { id: 'pro', contextWindow: 2000, contextFrom: 'catalog' }] });
    store.setDefaultModel({ connectionId: v.id, model: 'pro' });
    store.setStrongModel({ connectionId: v.id, model: 'pro' });
    store.save({ ...draft, id: v.id, secret: undefined, models: [{ id: 'flash', contextWindow: 1000, contextFrom: 'catalog' }] });
    expect(store.defaultRef()).toEqual({ connectionId: v.id, model: 'flash' });
    expect(store.strongRef()).toEqual({ connectionId: v.id, model: 'flash' });
    expect(store.resolved()[0]?.models.map((m) => m.id)).toEqual(['flash']);
  });

  it('keeps the most output a provider listed for a model, across a reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-prov-'));
    new ProviderStore(dir, box).save({ ...draft, models: [{ id: 'relay-a', contextWindow: 128_000, contextFrom: 'provider', maxOutput: 16_384 }, { id: 'b', contextWindow: 1000, contextFrom: 'user' }] });
    const again = new ProviderStore(dir, box).resolved()[0]!.models;
    expect(again.find((m) => m.id === 'relay-a')?.maxOutput).toBe(16_384);
    expect(again.find((m) => m.id === 'b')).not.toHaveProperty('maxOutput');
  });

  it('a provider’s 花费上限 is an amount for a period: kept as typed (four decimals at most), the period from when it was set, started again when either changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-prov-'));
    let now = 1_000_000;
    const store = new ProviderStore(dir, box, () => [], () => now);
    const first = store.save({ ...draft, spendLimitUsd: 0.015, spendPeriodDays: 7 });
    expect(first).toMatchObject({ spendLimitUsd: 0.015, spendPeriodDays: 7 });
    expect(first).not.toHaveProperty('spendFromMs');
    expect(store.spendLimit(first.id)).toEqual({ usd: 0.015, days: 7, fromMs: 1_000_000 });
    // saved again unchanged: the same period goes on
    now = 2_000_000;
    store.save({ ...draft, id: first.id, spendLimitUsd: 0.015, spendPeriodDays: 7 });
    expect(store.spendLimit(first.id)?.fromMs).toBe(1_000_000);
    // a new amount or period starts it again
    now = 3_000_000;
    store.save({ ...draft, id: first.id, spendLimitUsd: 0.015, spendPeriodDays: 30 });
    expect(store.spendLimit(first.id)).toEqual({ usd: 0.015, days: 30, fromMs: 3_000_000 });
    // more than four decimals is refused (the form says so in red); so is a period that is not 1..365 days
    expect(() => store.save({ ...draft, id: first.id, spendLimitUsd: 0.00015 })).toThrow(/最多四位小数/);
    expect(() => store.save({ ...draft, id: first.id, spendLimitUsd: 1, spendPeriodDays: 0 })).toThrow(/天数须为/);
    store.save({ ...draft, id: first.id, spendLimitUsd: null });
    const again = new ProviderStore(dir, box);
    expect(again.list()[0]!.spendLimitUsd).toBeNull();
    expect(again.spendLimit(first.id)).toBeNull();
    expect(() => new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box).save({ ...draft, spendLimitUsd: Number.NaN })).toThrow(/须为 0 到/);
    // 0 is no limit too (as empty)
    const zero = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box).save({ ...draft, spendLimitUsd: 0 });
    expect(zero.spendLimitUsd).toBeNull();
  });

  it('a limit saved before it had a period (a total with a 清零 point) reads as 30 days from when it is read, and is written so at once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-prov-'));
    const first = new ProviderStore(dir, box).save(draft);
    const file = join(dir, 'providers.json');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { items: Record<string, unknown>[] };
    raw.items[0]!.spendLimitUsd = 2.005;
    raw.items[0]!.spendBaseUsd = 1.5;
    delete raw.items[0]!.spendPeriodDays;
    delete raw.items[0]!.spendFromMs;
    writeFileSync(file, JSON.stringify(raw));
    const again = new ProviderStore(dir, box, () => [], () => 5_000_000);
    expect(again.spendLimit(first.id)).toEqual({ usd: 2.005, days: 30, fromMs: 5_000_000 });
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/spendBaseUsd/);
    expect(new ProviderStore(dir, box, () => [], () => 9_000_000).spendLimit(first.id)?.fromMs).toBe(5_000_000);
  });

  it('an unchecked model stays in the list (no 上下文上限 needed), is not offered, and the pointers leave it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-prov-'));
    const store = new ProviderStore(dir, box);
    const v = store.save({ ...draft, models: [{ id: 'flash', contextWindow: 1000, contextFrom: 'catalog' }, { id: 'pro', contextWindow: 2000, contextFrom: 'catalog' }] });
    store.setDefaultModel({ connectionId: v.id, model: 'pro' });
    store.save({ ...draft, id: v.id, secret: undefined, models: [{ id: 'flash', contextWindow: 1000, contextFrom: 'catalog' }, { id: 'pro', contextWindow: 2000, contextFrom: 'catalog', enabled: false }, { id: 'later', contextWindow: null, contextFrom: 'user', enabled: false }] });
    expect(store.defaultRef()).toEqual({ connectionId: v.id, model: 'flash' });
    expect(store.resolved()[0]?.models.map((m) => m.id)).toEqual(['flash']);
    // Still in the list, also after a restart.
    const again = new ProviderStore(dir, box).list()[0]!;
    expect(again.models.map((m) => [m.id, m.enabled !== false])).toEqual([['flash', true], ['pro', false], ['later', false]]);
  });

  it('a second key of the same provider is a second connection; each shows its first and last characters', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    const one = store.save({ ...draft, secret: 'sk-one-0000000000000000003f9a' });
    const two = store.save({ ...draft, name: 'DeepSeek 2', secret: 'sk-two-0000000000000000081c2' });
    expect([one.keyMask, two.keyMask]).toEqual(['sk-o****3f9a', 'sk-t****81c2']);
    expect(one.id).not.toBe(two.id);
  });

  it('moves the default when the default one is deleted', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    const a = store.save(draft);
    const b = store.save({ ...draft, name: '第二个' });
    store.setDefault(b.id);
    store.remove(b.id);
    expect(store.defaultId()).toBe(a.id);
  });

  it('does not take the default away from an existing outside model', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box, () => [{ id: 'openai', models: ['gpt-x'] }]);
    const v = store.save(draft);
    expect(store.defaultId()).toBe('openai');
    expect(v.isDefault).toBe(false);
    store.setDefault(v.id);
    expect(store.defaultId()).toBe(v.id);
    store.setDefault('openai');
    expect(store.defaultId()).toBe('openai');
  });

  it('will not store a secret it cannot encrypt', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), { ...box, available: () => false });
    expect(() => store.save(draft)).toThrow('无法加密保存密钥');
  });
});

describe('fake connection tester', () => {
  const test = createFakeTester({ delayMs: 0 });
  it('passes a complete form and fails a bad key or address', async () => {
    expect(await test(draft, undefined)).toMatchObject({ ok: true });
    expect(await test({ ...draft, secret: 'bad-key' }, undefined)).toMatchObject({ ok: false, message: '密钥无效或已失效（401）。' });
    expect(await test({ ...draft, baseUrl: 'https://gateway.invalid/v1' }, undefined)).toMatchObject({ ok: false });
    expect(await test({ ...draft, model: '' }, undefined)).toMatchObject({ ok: false, message: '请填写模型' });
  });

describe('local providers', () => {
  it('save without a key when the catalog says none is needed; others still need one', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    const local = { ...draft, name: 'Ollama', baseUrl: 'http://localhost:11434/v1', catalogId: 'ollama', secret: undefined };
    expect(() => store.save(local)).toThrow('请填写 API Key');
    expect(store.save(local, { needsKey: false })).toMatchObject({ name: 'Ollama', hasSecret: false, catalogId: 'ollama' });
  });
});
  it('a key shows never more than a third of itself', () => {
    expect(keyMaskText(keyMaskParts('sk-0123456789abcdef0123456789abcd3f9a'))).toBe('sk-0****3f9a');
    expect(keyMaskText(keyMaskParts('ck-0123456789ab'))).toBe('****89ab');
    expect(keyMaskText(keyMaskParts('short-key'))).toBe('****');
  });
});

describe('no two connections with one name', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'spica-prov-'));

  it('a new connection, or a rename, cannot take another connection’s name (spaces and letter case aside); its own name it keeps', () => {
    const store = new ProviderStore(dir(), box);
    const first = store.save(draft);
    expect(() => store.save({ ...draft, name: '测试网关' })).toThrow('名称已存在');
    expect(() => store.save({ ...draft, name: ' 测试网关 ' })).toThrow('名称已存在');
    const second = store.save({ ...draft, name: 'Relay' });
    expect(() => store.save({ ...draft, id: second.id, name: 'relay ' })).not.toThrow();
    expect(() => store.save({ ...draft, id: second.id, name: '测试网关' })).toThrow('名称已存在');
    // Saving a connection again under its own name is not a clash.
    expect(store.save({ ...draft, id: first.id }).name).toBe('测试网关');
    expect(store.list().map((p) => p.name)).toEqual(['测试网关', 'relay']);
  });

  it('the names connections from .env.local carry are taken too', () => {
    const store = new ProviderStore(dir(), box);
    for (const name of ['开发用模型（.env.local）', '开发用模型（OpenAI 兼容）', '开发用模型（Anthropic）']) expect(() => store.save({ ...draft, name })).toThrow('名称已存在');
  });

  it('two saved under one name before this rule are both still listed and used; each must be renamed only when it is next saved', () => {
    const d = dir();
    const store = new ProviderStore(d, box);
    const a = store.save(draft);
    const b = store.save({ ...draft, name: '另一个' });
    // As an older version could leave it: the same name twice.
    const file = join(d, 'providers.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"另一个"', '"测试网关"'));
    const later = new ProviderStore(d, box);
    expect(later.list().map((p) => p.name)).toEqual(['测试网关', '测试网关']);
    expect(later.resolved().map((p) => p.id)).toEqual([a.id, b.id]);
    expect(() => later.save({ ...draft, id: b.id, name: '测试网关', model: 'model-b' })).toThrow('名称已存在');
    expect(later.save({ ...draft, id: b.id, name: '测试网关 2', model: 'model-b' }).name).toBe('测试网关 2');
  });
});

describe('ProviderStore · 自定义请求头 and 凭据位置', () => {
  const relay = { ...draft, secret: undefined, name: '中转', baseUrl: 'https://gateway.example.com/v1' };

  it('seals each header value like a key, shows it masked, and gives it to the core', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-prov-'));
    const store = new ProviderStore(dir, box);
    const value = 'gw-key-0000000000000000000a1b2';
    // the key goes in the gateway's own header: no API Key needed
    const view = store.save({ ...relay, headers: [{ name: ' X-API-Key ', value }, { name: '' }] });
    expect(view.savedHeaders).toEqual([{ name: 'X-API-Key', mask: keyMaskText(keyMaskParts(value)) }]);
    expect(JSON.stringify(view)).not.toContain(value);
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).not.toContain(value);
    expect(store.resolved()[0]).toMatchObject({ secret: '', headerValues: { 'X-API-Key': value } });
  });

  it('an empty value keeps the saved one; a removed row is gone; a script change without headers keeps them', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    const v = store.save({ ...draft, headers: [{ name: 'X-API-Key', value: 'one-0000000000' }, { name: 'X-Team', value: 'team-a' }] });
    store.save({ ...draft, id: v.id, secret: undefined, headers: [{ name: 'x-api-key', saved: true }, { name: 'X-Team', value: 'team-b', saved: true }] });
    expect(store.resolved()[0]?.headerValues).toEqual({ 'x-api-key': 'one-0000000000', 'X-Team': 'team-b' });
    store.save({ ...draft, id: v.id, secret: undefined, model: 'model-b' });
    expect(store.resolved()[0]?.headerValues).toEqual({ 'x-api-key': 'one-0000000000', 'X-Team': 'team-b' });
    store.save({ ...draft, id: v.id, secret: undefined, headers: [{ name: 'X-Team', saved: true }] });
    expect(store.resolved()[0]?.headerValues).toEqual({ 'X-Team': 'team-b' });
    store.save({ ...draft, id: v.id, secret: undefined, headers: [] });
    expect(store.resolved()[0]).not.toHaveProperty('headerValues');
    expect(store.list()[0]).not.toHaveProperty('savedHeaders');
  });

  it('a header-only connection saved by a script change keeps working without an API Key', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    const v = store.save({ ...relay, headers: [{ name: 'X-API-Key', value: 'k-0000000000' }] });
    expect(() => store.save({ ...relay, id: v.id, model: 'model-b' })).not.toThrow();
    expect(() => store.save({ ...relay, id: v.id, headers: [] })).toThrow('请填写 API Key');
  });

  it('headersFor: what 测试连接 and 获取模型列表 send — typed values, else the saved ones of that name', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    const v = store.save({ ...draft, headers: [{ name: 'X-API-Key', value: 'saved-0000000000' }] });
    expect(store.headersFor({ headers: [{ name: 'X-API-Key', saved: true }, { name: 'X-New', value: 'typed' }] }, v.id)).toEqual({ 'X-API-Key': 'saved-0000000000', 'X-New': 'typed' });
    expect(store.headersFor({}, v.id)).toEqual({ 'X-API-Key': 'saved-0000000000' });
    expect(store.headersFor({ headers: [{ name: 'X-API-Key', saved: true }] })).toEqual({});
  });

  it('凭据位置: 自动 unless set; a script change without it keeps it; older files stay 自动', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    const gw = { ...emptyDraft('wso2'), name: 'gw', baseUrl: 'https://gateway.example.com/v1', tokenUrl: 'https://gateway.example.com/token', clientId: 'ck', model: 'm', contextWindow: 1000, secret: 's' };
    const v = store.save(gw);
    expect(store.list()[0]?.credentialsIn).toBeNull();
    expect(store.resolved()[0]).not.toHaveProperty('credentialsIn');
    store.save({ ...gw, id: v.id, credentialsIn: 'body' });
    store.save({ ...gw, id: v.id, model: 'm2' });
    expect(store.resolved()[0]?.credentialsIn).toBe('body');
    store.save({ ...gw, id: v.id, credentialsIn: null });
    expect(store.resolved()[0]).not.toHaveProperty('credentialsIn');
  });

  it('refuses header rows that cannot be sent, in plain words', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    expect(() => store.save({ ...draft, headers: [{ name: 'X API Key', value: 'v' }] })).toThrow('请求头名称「X API Key」只能包含字母、数字和 - _ .');
    expect(() => store.save({ ...draft, headers: [{ name: 'Content-Type', value: 'v' }] })).toThrow('请求头「Content-Type」由应用设置');
    expect(() => store.save({ ...draft, headers: [{ name: 'X-A', value: 'v' }, { name: 'x-a', value: 'w' }] })).toThrow('请求头「x-a」重复');
    expect(() => store.save({ ...draft, headers: [{ name: 'X-A' }] })).toThrow('请填写请求头「X-A」的值');
    expect(() => store.save({ ...draft, headers: [{ name: 'X-A', value: 'a\nb' }] })).toThrow('请求头「X-A」的值不能换行');
    // a WSO2 connection still needs its Consumer Secret
    expect(() => store.save({ ...emptyDraft('wso2'), name: 'w', baseUrl: 'https://g/v1', tokenUrl: 'https://g/t', clientId: 'c', model: 'm', contextWindow: 1, headers: [{ name: 'X-A', value: 'v' }] })).toThrow('请填写 Consumer Secret');
  });
});
