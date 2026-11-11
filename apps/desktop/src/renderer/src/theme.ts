import { deriveTokens, schemeOf, type Skin } from '../../shared/skin';
import { CODE_THEME_VARS, codeThemeVars } from '../../shared/code-themes';

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

/** Sets the font size of code blocks in answers (外观 › 代码 › 字号). */
export function applyCodeSize(px: number, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--code-size', `${px}px`);
}

/** Sets the code colours for the skin's scheme (外观 › 代码); 跟随皮肤 clears them, so the skin's own show. */
export function applyCodeTheme(theme: { light: string; dark: string }, scheme: 'light' | 'dark', root: HTMLElement = document.documentElement): void {
  for (const name of CODE_THEME_VARS) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(codeThemeVars(theme[scheme], scheme))) root.style.setProperty(name, value);
}
