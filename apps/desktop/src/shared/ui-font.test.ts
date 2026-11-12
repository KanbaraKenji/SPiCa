import { describe, expect, it } from 'vitest';
import { SYSTEM_FONT_PLAIN, SYSTEM_FONT_SEGOE, UI_FONT_FAMILY, uiFontFamily } from './ui-font';
import { parseDialogSpec } from './app-dialog';

describe('外观 › 界面字体', () => {
  it('默认 is Segoe UI with YaHei UI for Chinese, whatever the language', () => {
    for (const lang of ['zh-CN', 'en-US', 'ja', '']) expect(uiFontFamily('default', lang)).toBe(UI_FONT_FAMILY);
  });

  it('跟随系统 is system-ui; uncorrected where it is a Chinese, Japanese or Korean font, Segoe’s corrected faces elsewhere', () => {
    for (const lang of ['zh-CN', 'zh-TW', 'zh', 'ja-JP', 'ko']) expect(uiFontFamily('system', lang)).toBe(SYSTEM_FONT_PLAIN);
    for (const lang of ['en-US', 'de', 'fr-FR', '']) expect(uiFontFamily('system', lang)).toBe(SYSTEM_FONT_SEGOE);
    expect(SYSTEM_FONT_PLAIN.startsWith('system-ui')).toBe(true);
    expect(SYSTEM_FONT_SEGOE).toContain('system-ui');
  });

  it('the small dialog window takes only one of these stacks', () => {
    const spec = (font: unknown) => parseDialogSpec(JSON.stringify({ title: 't', buttons: [{ label: 'OK' }], scheme: 'dark', tokens: {}, font }));
    expect(spec(SYSTEM_FONT_PLAIN)?.font).toBe(SYSTEM_FONT_PLAIN);
    expect(spec(UI_FONT_FAMILY)?.font).toBe(UI_FONT_FAMILY);
    expect(spec('x; } body { display: none')?.font).toBeUndefined();
    expect(spec(undefined)?.font).toBeUndefined();
  });
});
