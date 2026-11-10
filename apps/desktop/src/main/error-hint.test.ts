import { describe, expect, it } from 'vitest';
import { withErrorHint } from './error-hint';

describe('a conversation error’s words', () => {
  it('a WSO2 gateway missing /v1: the core’s hint, naming 网关地址, is kept (not looked up again as 接口地址)', () => {
    // As the core words it for a WSO2 connection (netHint with kind wso2).
    const hint = '路径无效（HTTP 404），请检查 网关地址 是否需要以 /v1 结尾。';
    const e = withErrorHint({ type: 'error', message: 'HTTP 404', code: 'gateway.not_found_version', hint });
    expect(e.hint).toBe(hint);
    expect(e.hint).not.toContain('接口地址');
  });

  it('only a code (an older core): the words for it', () => {
    const e = withErrorHint({ type: 'error', message: 'x', code: 'c1' } as { type: string; message: string; code: string; hint?: string }, { c1: '请检查 接口地址。' });
    expect(e.hint).toBe('请检查 接口地址。');
  });

  it('other events and unknown codes pass as they are', () => {
    const text = { type: 'text.delta', text: 'a' };
    expect(withErrorHint(text)).toBe(text);
    const e = { type: 'error', message: 'x', code: 'nope' };
    expect(withErrorHint(e, {})).toBe(e);
  });
});
