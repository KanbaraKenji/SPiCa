import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

  it('keeps the saved secret when the draft leaves it empty', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    const v = store.save(draft);
    store.save({ ...draft, id: v.id, secret: undefined, model: 'model-b' });
    expect(store.resolved()[0]).toMatchObject({ model: 'model-b', secret: 'sk-123' });
  });

  it('refuses incomplete forms in plain words', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    expect(() => store.save({ ...draft, baseUrl: 'api.example.com' })).toThrow('地址要以 http:// 或 https:// 开头');
    expect(() => store.save({ ...emptyDraft('wso2'), name: 'w', baseUrl: 'https://g/v1', model: 'm', secret: 's' })).toThrow('填取 token 的地址');
  });

  it('a version 1 file becomes connections: same ids, model and strong model ticked, the default where it was', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-prov-'));
    const sealed = box.encrypt('sk-old-9f3a');
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
    expect(a).toMatchObject({ id: 'p-a', models: [{ id: 'm-a', contextWindow: null }], keyTail: '9f3a', hasSecret: true });
    expect(b).toMatchObject({ id: 'p-b', maxConcurrent: 2, models: [{ id: 'm-b', contextWindow: 64000 }, { id: 'm-b-pro', contextWindow: null }] });
    expect(store.defaultRef()).toEqual({ connectionId: 'p-b', model: 'm-b' });
    expect(store.strongRef()).toEqual({ connectionId: 'p-b', model: 'm-b-pro' });
    expect(store.secretOf('p-a')).toBe('sk-old-9f3a');
    // Rewritten as version 2 once; reading it again gives the same.
    expect(JSON.parse(readFileSync(join(dir, 'providers.json'), 'utf8')).version).toBe(2);
    expect(new ProviderStore(dir, box).list()).toEqual(store.list());
    // A model without a window still has to get one before the one-model form saves it.
    expect(() => store.save({ ...draft, id: 'p-a', contextWindow: null })).toThrow('必须填这一项');
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

  it('a second key of the same provider is a second connection; each shows its key tail', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    const one = store.save({ ...draft, secret: 'sk-one-3f9a' });
    const two = store.save({ ...draft, name: 'DeepSeek 2', secret: 'sk-two-81c2' });
    expect([one.keyTail, two.keyTail]).toEqual(['3f9a', '81c2']);
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
    expect(() => store.save(draft)).toThrow('没法安全保存密钥');
  });
});

describe('fake connection tester', () => {
  const test = createFakeTester({ delayMs: 0 });
  it('passes a complete form and fails a bad key or address', async () => {
    expect(await test(draft, undefined)).toMatchObject({ ok: true });
    expect(await test({ ...draft, secret: 'bad-key' }, undefined)).toMatchObject({ ok: false, message: '密钥不对或已失效（401）。' });
    expect(await test({ ...draft, baseUrl: 'https://gateway.invalid/v1' }, undefined)).toMatchObject({ ok: false });
    expect(await test({ ...draft, model: '' }, undefined)).toMatchObject({ ok: false, message: '填要用的模型名' });
  });

describe('local providers', () => {
  it('save without a key when the catalog says none is needed; others still need one', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    const local = { ...draft, name: 'Ollama', baseUrl: 'http://localhost:11434/v1', catalogId: 'ollama', secret: undefined };
    expect(() => store.save(local)).toThrow('填 API Key');
    expect(store.save(local, { needsKey: false })).toMatchObject({ name: 'Ollama', hasSecret: false, catalogId: 'ollama' });
  });
});
});
