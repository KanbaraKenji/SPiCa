import { describe, expect, it, vi } from 'vitest';
import { NET_HINTS, netHint } from '@spica/core/src/net.ts';
import { NET_WORDS, netWordsKey } from '../shared/errors';
import { setLocale } from '../shared/i18n';
import { EN_MAIN } from '../shared/i18n/en/main';
import { ZH_TW_MAIN } from '../shared/i18n/zh-TW/main';
import { withErrorHint } from './error-hint';

// The main area's English, also before en.ts takes it in (shared/i18n/en.ts merges the area files).
vi.mock('../shared/i18n/en', async (actual) => ({ EN: { ...(await actual<typeof import('../shared/i18n/en')>()).EN, ...(await import('../shared/i18n/en/main')).EN_MAIN } }));

describe('a conversation error’s words', () => {
  it('a WSO2 gateway missing /v1: the core’s hint, naming 网关地址, is kept (not looked up again as 接口地址)', () => {
    // As the core words it for a WSO2 connection (netHint with kind wso2).
    const hint = '路径无效（HTTP 404），请检查「网关地址」是否需要以 /v1 结尾。';
    const e = withErrorHint({ type: 'error', message: 'HTTP 404', code: 'gateway.not_found_version', hint });
    expect(e.hint).toBe(hint);
    expect(e.hint).not.toContain('接口地址');
  });

  it('only a code (an older core): the words for it', () => {
    const e = withErrorHint({ type: 'error', message: 'x', code: 'c1' } as { type: string; message: string; code: string; hint?: string }, { c1: '请检查「接口地址」。' });
    expect(e.hint).toBe('请检查「接口地址」。');
  });

  it('other events and unknown codes pass as they are', () => {
    const text = { type: 'text.delta', text: 'a' };
    expect(withErrorHint(text)).toBe(text);
    const e = { type: 'error', message: 'x', code: 'nope' };
    expect(withErrorHint(e, {})).toBe(e);
  });
});

describe('the core’s network hints in the interface’s languages', () => {
  const kinds = [undefined, 'openai-compatible', 'anthropic', 'wso2'] as const;

  it('every code of NET_HINTS has the shell’s words, the same as the core’s in Simplified for each kind of connection', () => {
    for (const code of Object.keys(NET_HINTS)) {
      expect(NET_WORDS[code], code).toBe(NET_HINTS[code]);
      for (const kind of kinds) expect(netWordsKey(code, kind), `${code} ${kind}`).toBe(netHint(code, kind));
    }
  });

  it('every one of those words is in the English and Traditional catalogs', () => {
    for (const code of Object.keys(NET_HINTS))
      for (const kind of kinds) {
        const key = netWordsKey(code, kind)!;
        expect(EN_MAIN[key], key).toBeDefined();
        expect(ZH_TW_MAIN[key], key).toBeDefined();
      }
  });

  it('a conversation’s error says the hint in the language now; words the shell does not know as sent', () => {
    const missing = NET_HINTS['wso2.missing_credentials']!;
    expect(withErrorHint({ type: 'error', message: 'x', code: 'wso2.missing_credentials', hint: missing }).hint).toBe(missing);
    setLocale('en');
    try {
      expect(withErrorHint({ type: 'error', message: 'x', code: 'wso2.missing_credentials', hint: missing }).hint).toBe(EN_MAIN[missing]);
      const gateway = netHint('list.unsupported', 'wso2')!;
      expect(withErrorHint({ type: 'error', message: 'x', code: 'list.unsupported', hint: gateway }).hint).toBe(EN_MAIN[gateway]);
      expect(withErrorHint<{ type: string; message: string; code: string; hint?: string }>({ type: 'error', message: 'x', code: 'net.dns' }).hint).toBe(EN_MAIN[NET_HINTS['net.dns']!]);
      const odd = '内核新写的一句话。';
      expect(withErrorHint({ type: 'error', message: 'x', code: 'net.dns', hint: odd }).hint).toBe(odd);
    } finally {
      setLocale('zh-CN');
    }
  });
});
