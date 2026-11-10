import { describe, expect, it } from 'vitest';
import { emptyDraft, type ProviderView } from '../../shared/providers';
import { fromHostDraft, toHostModel } from './host-models';

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
  isDefault: true,
};

describe('model settings for the core', () => {
  it('spells the kind the core way and sends the Consumer Key in full (the core masks it)', () => {
    expect(toHostModel(saved)).toMatchObject({ id: 'p-1', kind: 'wso2', clientId: 'key-ABCD1234', hasSecret: true, isDefault: true });
    expect(toHostModel({ ...saved, kind: 'openai' }).kind).toBe('openai-compatible');
  });

  it('takes a draft back in the settings page shape; a missing secret keeps the saved one', () => {
    const d = fromHostDraft({ ...toHostModel(saved), kind: 'openai-compatible', model: 'm2' }, [saved]);
    expect(d).toMatchObject({ id: 'p-1', kind: 'openai', model: 'm2', contextWindow: 128_000 });
    expect('secret' in d).toBe(false);
    expect(fromHostDraft({ ...toHostModel(saved), id: undefined, secret: 's' } as never, [saved]).secret).toBe('s');
  });

  it('refuses unknown ids and read-only models in plain words, with a code', () => {
    expect(() => fromHostDraft({ ...toHostModel(saved), id: 'nope' }, [saved])).toThrow('找不到这个模型配置。');
    expect(() => fromHostDraft({ ...toHostModel(saved) }, [{ ...saved, readOnly: true }])).toThrow('开发配置文件');
    try {
      fromHostDraft({ ...toHostModel(saved), id: 'nope' }, [saved]);
    } catch (e) {
      expect((e as { code?: string }).code).toBe('not_found');
    }
  });
});
