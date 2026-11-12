import { deriveTokens, schemeOf, type Skin } from '../../shared/skin';
import { CODE_THEME_VARS, codeThemeVars } from '../../shared/code-themes';
import { SYSTEM_FONT_PLAIN, SYSTEM_FONT_SEGOE, uiFontFamily, type UiFontMode } from '../../shared/ui-font';

/** Writes every color token of a skin onto :root. */
export function applySkin(skin: Skin, root: HTMLElement = document.documentElement): void {
  const tokens = deriveTokens(skin);
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  root.dataset.scheme = schemeOf(skin.bg);
  root.style.colorScheme = schemeOf(skin.bg);
}

/** Sets the conversation's text size (外观 › 文字大小); the style sheet moves its sizes for 小 and 大. */
export function applyTextSize(size: 'sm' | 'md' | 'lg', root: HTMLElement = document.documentElement): void {
  root.dataset.textSize = size;
}

/**
 * The interface font's stack for 外观 › 界面字体 here (shared/ui-font.ts). For 跟随系统 on a system whose interface font
 * should be Segoe UI, it checks that system-ui really draws as Segoe UI does (the same width for the same words) before
 * taking Segoe's corrected faces; any other font gets plain system-ui, uncorrected, as it was.
 */
export function uiFontFor(mode: UiFontMode, lang: string = typeof navigator === 'undefined' ? '' : navigator.language): string {
  const family = uiFontFamily(mode, lang);
  if (family !== SYSTEM_FONT_SEGOE) return family;
  const ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!ctx) return family;
  const width = (font: string) => {
    ctx.font = `100px ${font}`;
    return ctx.measureText('Settings 0123 HOSHI').width;
  };
  const sys = width('system-ui');
  return [width("'Segoe UI Variable Text'"), width("'Segoe UI'")].some((w) => Math.abs(w - sys) < 0.5) ? family : SYSTEM_FONT_PLAIN;
}

/** Sets the interface font (外观 › 界面字体): 默认 is the style sheet's own --font-ui; code keeps --font-mono. */
export function applyUiFont(mode: UiFontMode, root: HTMLElement = document.documentElement): void {
  if (mode === 'system') root.style.setProperty('--font-ui', uiFontFor(mode));
  else root.style.removeProperty('--font-ui');
}

/** Sets the font size of code blocks in answers (外观 › 代码 › 字号). */
export function applyCodeSize(px: number, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--code-size', `${px}px`);
}

/** Sets the code colours for the skin's scheme (外观 › 代码); 跟随皮肤 clears them, so the skin's own show. */
export function applyCodeTheme(theme: { light: string; dark: string }, scheme: 'light' | 'dark', root: HTMLElement = document.documentElement): void {
  for (const name of CODE_THEME_VARS) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(codeThemeVars(theme[scheme], scheme))) root.style.setProperty(name, value);
}
