// Code colours (设置 › 外观 › 代码): a few well-known themes, one for light skins and one for dark ones. Each is a
// palette for the highlight classes the page uses (chat/highlight.ts, styles.css .hl-*), set as CSS variables;
// 跟随皮肤 sets none, so the code takes the skin's own colours. A theme without a light (or dark) version is only
// offered for the other.

export interface CodePalette {
  /** Absent: the skin's own code background. */
  bg?: string;
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
  /** Object keys, attributes. */
  attr: string;
  /** Lines added and removed (diff); a background absent: the skin's. */
  addition: string;
  additionBg?: string;
  deletion: string;
  deletionBg?: string;
  // Finer parts some themes colour on their own; absent: as the group they belong to above.
  /** Function names where they are declared (title.function). */
  fn?: string;
  /** Built-in names (console, Math). */
  builtIn?: string;
  /** `this`, `self` (variable.language). */
  language?: string;
  params?: string;
  /** Properties (a.b), object keys. */
  property?: string;
  /** HTML and CSS attribute names. */
  attrName?: string;
  regex?: string;
  /** true, false, null. */
  literal?: string;
  punctuation?: string;
  /** Preprocessor lines, decorators. */
  meta?: string;
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

/**
 * Claude 风格: the code colours of the Claude desktop app (one per kind of code element, taken from its package),
 * on the skin's own code background. Everything not listed takes the text colour.
 */
const CLAUDE_DARK = { fg: 'hsl(220, 15%, 93%)', comment: 'hsl(220, 10%, 55%)', punctuation: 'hsl(220, 15%, 85%)', keyword: 'hsl(280, 85%, 72%)', string: 'hsl(95, 75%, 65%)', regex: 'hsl(95, 70%, 63%)', number: 'hsl(180, 80%, 65%)', property: 'hsl(355, 85%, 72%)', attrName: 'hsl(355, 80%, 70%)', fn: 'hsl(210, 100%, 72%)', variable: 'hsl(30, 95%, 68%)', params: 'hsl(30, 90%, 67%)' };
const CLAUDE_LIGHT = { fg: 'hsl(220, 20%, 10%)', comment: 'hsl(220, 10%, 48%)', punctuation: 'hsl(220, 15%, 20%)', keyword: 'hsl(280, 100%, 38%)', string: 'hsl(120, 100%, 25%)', regex: 'hsl(120, 90%, 27%)', number: 'hsl(180, 100%, 25%)', property: 'hsl(355, 90%, 38%)', attrName: 'hsl(355, 85%, 40%)', fn: 'hsl(215, 100%, 38%)', variable: 'hsl(25, 100%, 35%)', params: 'hsl(25, 95%, 37%)' };
function claude(c: typeof CLAUDE_DARK): CodePalette {
  return { ...c, title: c.fg, type: c.fg, attr: c.property, builtIn: c.keyword, language: c.keyword, literal: c.fg, meta: c.fg, addition: c.string, deletion: c.property };
}

export const CODE_THEMES: readonly CodeTheme[] = [
  { id: SKIN_CODE_THEME, name: '跟随皮肤' },
  { id: 'claude', name: 'Claude 风格', light: claude(CLAUDE_LIGHT), dark: claude(CLAUDE_DARK) },
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
  const out: Record<string, string> = {};
  for (const [key, name] of Object.entries(VAR_OF) as [keyof CodePalette, string][]) {
    const v = p[key];
    if (v) out[name] = v;
  }
  return out;
}

/** The CSS variable for each part of a palette (styles.css .hl-* rules). */
const VAR_OF: Record<keyof CodePalette, string> = {
  bg: '--code-bg',
  fg: '--code-fg',
  comment: '--hl-comment',
  keyword: '--hl-keyword',
  string: '--hl-string',
  number: '--hl-number',
  title: '--hl-title',
  type: '--hl-type',
  variable: '--hl-variable',
  attr: '--hl-attr',
  addition: '--hl-addition',
  additionBg: '--hl-addition-bg',
  deletion: '--hl-deletion',
  deletionBg: '--hl-deletion-bg',
  fn: '--hl-function',
  builtIn: '--hl-built-in',
  language: '--hl-language',
  params: '--hl-params',
  property: '--hl-property',
  attrName: '--hl-attr-name',
  regex: '--hl-regex',
  literal: '--hl-literal',
  punctuation: '--hl-punctuation',
  meta: '--hl-meta',
};

/** Every variable a palette may set (to clear them when going back to 跟随皮肤). */
export const CODE_THEME_VARS = Object.values(VAR_OF);

/** 外观 › 代码 › 字号: the sizes a code block in an answer can be, in px; 13 unless picked. */
export const CODE_SIZES = [12, 13, 14, 15] as const;
export const DEFAULT_CODE_SIZE = 13;

/** A stored size, or the default when it is not one of CODE_SIZES. */
export function codeSize(value: unknown): number {
  return typeof value === 'number' && (CODE_SIZES as readonly number[]).includes(value) ? value : DEFAULT_CODE_SIZE;
}
