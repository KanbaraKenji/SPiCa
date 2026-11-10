import { describe, expect, it } from 'vitest';
import { emptyDraft, type ProviderView } from '../../shared/providers';
import { fromHostDraft, toHostConnection, toHostModelList } from './host-models';

const saved: ProviderView = {
  ...emptyDraft('wso2'),
  id: 'p-1',
  name: '网关',
  baseUrl: 'https://gw.example.com/v1',
  tokenUrl: 'https://gw.example.com/oauth2/token',
  clientId: 'key-ABCD1234',
  model: 'm',
  contextWindow: 128_000,
  hasSecret: true,
  keyTail: '1234',
  models: [
    { id: 'm', contextWindow: 128_000, contextFrom: 'user' },
    { id: 'm-pro', contextWindow: null, contextFrom: 'user' },
  ],
  isDefault: true,
};

describe('model settings for the core (connections)', () => {
  it('a connection with its ticked models; the kind the core way, the Consumer Key in full (the core masks it)', () => {
    const c = toHostConnection(saved);
    expect(c).toMatchObject({ id: 'p-1', kind: 'wso2', clientId: 'key-ABCD1234', hasSecret: true });
    expect(c.models).toEqual([
      { id: 'm', contextWindow: 128_000, contextFrom: 'user' },
      { id: 'm-pro', contextWindow: 0, contextFrom: 'user' },
    ]);
    expect(toHostConnection({ ...saved, kind: 'openai' }).kind).toBe('openai-compatible');
    expect(toHostModelList([saved], { connectionId: 'p-1', model: 'm' }, null)).toMatchObject({ default: { connectionId: 'p-1', model: 'm' }, strong: null });
  });

  it('takes a draft back with its whole model list; a missing secret keeps the saved one', () => {
    const d = fromHostDraft({ ...toHostConnection(saved), kind: 'openai-compatible', models: [{ id: 'x', contextWindow: 64_000, contextFrom: 'name-match' }] }, [saved]);
    expect(d).toMatchObject({ id: 'p-1', kind: 'openai', models: [{ id: 'x', contextWindow: 64_000, contextFrom: 'name-match' }], model: 'x', contextWindow: 64_000 });
    expect('secret' in d).toBe(false);
    const { id: _id, ...fresh } = toHostConnection(saved);
    void _id;
    expect(fromHostDraft({ ...fresh, secret: 's' }, [saved]).secret).toBe('s');
  });

  it('refuses unknown ids and read-only connections in plain words, with a code', () => {
    expect(() => fromHostDraft({ ...toHostConnection(saved), id: 'nope' }, [saved])).toThrow('找不到该模型配置。');
    expect(() => fromHostDraft({ ...toHostConnection(saved) }, [{ ...saved, readOnly: true }])).toThrow('开发配置文件');
    try {
      fromHostDraft({ ...toHostConnection(saved), id: 'nope' }, [saved]);
    } catch (e) {
      expect((e as { code?: string }).code).toBe('not_found');
    }
  });
});
