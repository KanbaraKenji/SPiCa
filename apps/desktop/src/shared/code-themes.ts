// Code colours (设置 › 外观 › 代码): a few well-known themes, one for light skins and one for dark ones. Each is a
// palette for the highlight classes the page uses (chat/highlight.ts, styles.css .hl-*), set as CSS variables;
// 跟随皮肤 sets none, so the code takes the skin's own colours. A theme without a light (or dark) version is only
// offered for the other.

export interface CodePalette {
  bg: string;
  fg: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  /** Function and class names, section titles. */
  title: string;
  /** Built-in names, types, tags. */
  type: string;
  variable: string;
  attr: string;
  addition: string;
  additionBg: string;
  deletion: string;
  deletionBg: string;
}

export interface CodeTheme {
  id: string;
  name: string;
  /** A different name in one of the two lists, when the theme's two versions have names of their own. */
  names?: Partial<Record<'light' | 'dark', string>>;
  light?: CodePalette;
  dark?: CodePalette;
}

export const SKIN_CODE_THEME = 'skin';

export const CODE_THEMES: readonly CodeTheme[] = [
  { id: SKIN_CODE_THEME, name: '跟随皮肤' },
  {
    id: 'github',
    name: 'GitHub',
    light: { bg: '#f6f8fa', fg: '#1f2328', comment: '#6e7781', keyword: '#cf222e', string: '#0a3069', number: '#0550ae', title: '#8250df', type: '#953800', variable: '#953800', attr: '#0550ae', addition: '#116329', additionBg: '#dafbe1', deletion: '#82071e', deletionBg: '#ffebe9' },
    dark: { bg: '#0d1117', fg: '#e6edf3', comment: '#8b949e', keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', title: '#d2a8ff', type: '#ffa657', variable: '#ffa657', attr: '#79c0ff', addition: '#aff5b4', additionBg: '#033a16', deletion: '#ffdcd7', deletionBg: '#67060c' },
  },
  {
    id: 'one',
    name: 'One Dark Pro',
    names: { light: 'One Light' },
    light: { bg: '#fafafa', fg: '#383a42', comment: '#a0a1a7', keyword: '#a626a4', string: '#50a14f', number: '#986801', title: '#4078f2', type: '#c18401', variable: '#e45649', attr: '#986801', addition: '#50a14f', additionBg: '#e6f4e6', deletion: '#e45649', deletionBg: '#fbe6e5' },
    dark: { bg: '#282c34', fg: '#abb2bf', comment: '#7f848e', keyword: '#c678dd', string: '#98c379', number: '#d19a66', title: '#61afef', type: '#e5c07b', variable: '#e06c75', attr: '#d19a66', addition: '#98c379', additionBg: '#2c3b2d', deletion: '#e06c75', deletionBg: '#3d2a2d' },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    dark: { bg: '#282a36', fg: '#f8f8f2', comment: '#6272a4', keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', title: '#50fa7b', type: '#8be9fd', variable: '#ffb86c', attr: '#50fa7b', addition: '#50fa7b', additionBg: '#2b3a33', deletion: '#ff5555', deletionBg: '#3d2a33' },
  },
  {
    id: 'solarized',
    name: 'Solarized',
    light: { bg: '#fdf6e3', fg: '#586e75', comment: '#93a1a1', keyword: '#859900', string: '#2aa198', number: '#d33682', title: '#268bd2', type: '#b58900', variable: '#cb4b16', attr: '#268bd2', addition: '#859900', additionBg: '#eee8d5', deletion: '#dc322f', deletionBg: '#f5e2da' },
    dark: { bg: '#002b36', fg: '#839496', comment: '#586e75', keyword: '#859900', string: '#2aa198', number: '#d33682', title: '#268bd2', type: '#b58900', variable: '#cb4b16', attr: '#268bd2', addition: '#859900', additionBg: '#073642', deletion: '#dc322f', deletionBg: '#2e2420' },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    light: { bg: '#e1e2e7', fg: '#3760bf', comment: '#848cb5', keyword: '#9854f1', string: '#587539', number: '#b15c00', title: '#2e7de9', type: '#007197', variable: '#f52a65', attr: '#007197', addition: '#587539', additionBg: '#d5e3c9', deletion: '#f52a65', deletionBg: '#f2d5dc' },
    dark: { bg: '#1a1b26', fg: '#a9b1d6', comment: '#565f89', keyword: '#bb9af7', string: '#9ece6a', number: '#ff9e64', title: '#7aa2f7', type: '#2ac3de', variable: '#f7768e', attr: '#7dcfff', addition: '#9ece6a', additionBg: '#1f2b2a', deletion: '#f7768e', deletionBg: '#2d1f27' },
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    light: { bg: '#eff1f5', fg: '#4c4f69', comment: '#9ca0b0', keyword: '#8839ef', string: '#40a02b', number: '#fe640b', title: '#1e66f5', type: '#df8e1d', variable: '#d20f39', attr: '#04a5e5', addition: '#40a02b', additionBg: '#dcefd8', deletion: '#d20f39', deletionBg: '#f5d6dc' },
    dark: { bg: '#1e1e2e', fg: '#cdd6f4', comment: '#6c7086', keyword: '#cba6f7', string: '#a6e3a1', number: '#fab387', title: '#89b4fa', type: '#f9e2af', variable: '#f38ba8', attr: '#89dceb', addition: '#a6e3a1', additionBg: '#263129', deletion: '#f38ba8', deletionBg: '#362430' },
  },
];

/** The themes offered for light skins, or for dark ones. */
export function codeThemesFor(scheme: 'light' | 'dark'): CodeTheme[] {
  return CODE_THEMES.filter((t) => t.id === SKIN_CODE_THEME || t[scheme]);
}

/** The name shown in the list for that scheme. */
export function codeThemeName(theme: CodeTheme, scheme: 'light' | 'dark'): string {
  return theme.names?.[scheme] ?? theme.name;
}

/** A theme id that can be used for that scheme, else 跟随皮肤. */
export function codeThemeId(value: unknown, scheme: 'light' | 'dark'): string {
  return typeof value === 'string' && codeThemesFor(scheme).some((t) => t.id === value) ? value : SKIN_CODE_THEME;
}

/** The CSS variables a palette sets (none for 跟随皮肤: the page's own defaults take the skin's colours). */
export function codeThemeVars(id: string, scheme: 'light' | 'dark'): Record<string, string> {
  const p = CODE_THEMES.find((t) => t.id === id)?.[scheme];
  if (!p) return {};
  return {
    '--code-bg': p.bg,
    '--code-fg': p.fg,
    '--hl-comment': p.comment,
    '--hl-keyword': p.keyword,
    '--hl-string': p.string,
    '--hl-number': p.number,
    '--hl-title': p.title,
    '--hl-type': p.type,
    '--hl-variable': p.variable,
    '--hl-attr': p.attr,
    '--hl-addition': p.addition,
    '--hl-addition-bg': p.additionBg,
    '--hl-deletion': p.deletion,
    '--hl-deletion-bg': p.deletionBg,
  };
}

/** Every variable a palette may set (to clear them when going back to 跟随皮肤). */
export const CODE_THEME_VARS = Object.keys(codeThemeVars('github', 'light'));
