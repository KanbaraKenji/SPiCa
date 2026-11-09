import { mkdtempSync, readFileSync } from 'node:fs';
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

const draft = { ...emptyDraft('openai'), name: '测试网关', baseUrl: 'https://api.example.com/v1', model: 'model-a', secret: 'sk-123' };

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

  it('moves the default when the default one is deleted', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box);
    const a = store.save(draft);
    const b = store.save({ ...draft, name: '第二个' });
    store.setDefault(b.id);
    store.remove(b.id);
    expect(store.defaultId()).toBe(a.id);
  });

  it('does not take the default away from an existing outside model', () => {
    const store = new ProviderStore(mkdtempSync(join(tmpdir(), 'spica-prov-')), box, () => ['openai']);
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
});
