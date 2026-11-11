import { describe, expect, it } from 'vitest';
import { devConnectionName } from './providers';

describe('the name of a connection from .env.local', () => {
  it('one configured: the plain name; both: each says which it is, in the form’s words for the kind', () => {
    expect(devConnectionName('openai', false)).toBe('开发用模型（.env.local）');
    expect(devConnectionName('anthropic', false)).toBe('开发用模型（.env.local）');
    expect(devConnectionName('openai', true)).toBe('开发用模型（.env.local，OpenAI 兼容）');
    expect(devConnectionName('anthropic', true)).toBe('开发用模型（.env.local，Anthropic）');
    expect(devConnectionName('openai', true)).not.toBe(devConnectionName('anthropic', true));
  });
});
