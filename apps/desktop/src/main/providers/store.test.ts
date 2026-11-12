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

  it('a provider’s 花费上限 is kept to the cent (none when not an amount); 清零 keeps where 已花 starts, across a save and a reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-prov-'));
    const store = new ProviderStore(dir, box);
    const saved = store.save({ ...draft, spendLimitUsd: 2.005 });
    expect(saved.spendLimitUsd).toBe(2.01);
    expect(store.spendBase(saved.id)).toBe(0);
    store.resetSpend(saved.id, 1.5);
    store.save({ ...draft, id: saved.id, spendLimitUsd: null });
    const again = new ProviderStore(dir, box);
    expect(again.spendBase(saved.id)).toBe(1.5);
    expect(again.list()[0]!.spendLimitUsd).toBeNull();
    expect(again.list()[0]).not.toHaveProperty('spendBaseUsd');
    expect(() => new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box).save({ ...draft, spendLimitUsd: Number.NaN })).toThrow(/须为大于 0/);
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
