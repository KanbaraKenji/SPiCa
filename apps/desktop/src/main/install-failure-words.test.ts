// A failed python_env download reads the same on the card as in what the Agent is told: the window's catalogs
// and the core's table (python-tool.ts INSTALL_FAILURE_WORDS) say the same, in each of the three languages.
import { afterEach, describe, expect, it } from 'vitest';
import { INSTALL_FAILURE_WORDS, installFailureWords } from '@spica/core';
import { setLocale } from '../shared/i18n';
import { installFailureText } from '../renderer/src/chat/format';

afterEach(() => setLocale('zh-CN'));

describe('a failed download, card and Agent', () => {
  it('the same line in zh-CN, zh-TW and en, for every reason', () => {
    for (const locale of ['zh-CN', 'zh-TW', 'en'] as const) {
      setLocale(locale);
      for (const reason of Object.keys(INSTALL_FAILURE_WORDS) as (keyof typeof INSTALL_FAILURE_WORDS)[]) {
        const f = { reason, host: 'pypi.example.com', detail: 'x' };
        expect(installFailureText(f), `${locale} ${reason}`).toBe(installFailureWords(f, locale));
      }
      expect(installFailureText({ reason: 'connect', detail: 'x' })).toBe(installFailureWords({ reason: 'connect', detail: 'x' }, locale));
    }
  });
});
