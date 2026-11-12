// Skins: every color in the UI is derived from a few base colors here, so a
// user skin only needs a background and an accent. Shared by main (window
// background, title bar overlay) and renderer (CSS variables).

export type Scheme = 'light' | 'dark';

export interface Skin {
  id: string;
  name: string;
  /** Main background, #rrggbb. */
  bg: string;
  /** Accent (links, focus, primary buttons, the mark's long petals), #rrggbb. */
  accent: string;
  /**
   * Built-in skins only: values measured from the reference (统筹 2026-11-10,
   * ledger-briefs/reference-ui-colours-20261110.md), used as they are instead
   * of derived. A skin someone makes has none: everything is derived.
   */
  fixed?: Partial<Tokens>;
  builtin?: boolean;
}

// Both built-in skins take the reference's measured greys (neutral: red, green and blue equal).
export const LIGHT_SKIN: Skin = {
  id: 'light',
  name: '浅色',
  bg: '#ffffff',
  accent: '#2f7de1',
  fixed: {
    '--spica-ink': '#191919',
    '--spica-chrome': '#fafafa',
    '--spica-divider': '#e1e1e1',
    '--spica-muted': '#666666',
    '--spica-faint': '#878787',
    '--spica-placeholder': '#878787',
    '--spica-bubble': '#f3f3f3',
    '--spica-input': '#ffffff',
    '--spica-input-border': 'rgba(0, 0, 0, 0.12)',
    '--spica-input-shadow': '0 4px 20px rgba(0, 0, 0, 0.075)',
    '--spica-hover': '#eeeeee',
    '--spica-active': '#e1e1e1',
    '--spica-control': '#f2f2f2',
    '--spica-control-hover': '#e5e5e5',
    '--spica-code': '#f2f2f2',
    '--spica-border': '#fbfbfb',
    '--spica-border-strong': '#cecece',
    // Not measured: cards (settings, connections) would vanish white on white; the side panel's grey keeps their edge.
    '--spica-surface': '#fafafa',
    '--spica-raised': '#ffffff',
    '--spica-menu': '#ffffff',
    '--spica-menu-hover': '#e5e5e5',
  },
  builtin: true,
};
export const DARK_SKIN: Skin = {
  id: 'dark',
  name: '深色',
  bg: '#191919',
  accent: '#62a9ff',
  fixed: {
    '--spica-ink': '#efefef',
    '--spica-chrome': '#1f1f1f',
    // Measured as 10% (black or white could not be told apart); white 10% over the conversation.
    '--spica-divider': 'rgba(255, 255, 255, 0.1)',
    '--spica-muted': '#9c9c9c',
    '--spica-faint': '#878787',
    '--spica-placeholder': '#878787',
    '--spica-bubble': '#252525',
    '--spica-input': '#303030',
    '--spica-input-border': 'rgba(255, 255, 255, 0.08)',
    '--spica-input-shadow': '0 4px 20px rgba(0, 0, 0, 0.035)',
    '--spica-hover': '#2a2a2a',
    '--spica-active': '#404040',
    '--spica-control': '#3b3b3b',
    '--spica-control-hover': '#454545',
    '--spica-code': '#2a2a2a',
    '--spica-border': '#222222',
    '--spica-border-strong': '#474747',
    '--spica-raised': '#303030',
    '--spica-menu': '#303030',
    '--spica-menu-hover': '#454545',
  },
  builtin: true,
};
export const BUILTIN_SKINS: readonly Skin[] = [LIGHT_SKIN, DARK_SKIN];

/** `system` follows the OS light/dark setting with the two built-in skins. */
export type SkinChoice = 'system' | string;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX = /^#([0-9a-f]{6})$/i;

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

/** Parses #rgb or #rrggbb (case-insensitive) into #rrggbb, or returns undefined. */
export function normalizeHex(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const long = /^#?([0-9a-f]{6})$/.exec(v);
  return long ? `#${long[1]}` : undefined;
}

function toRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex({ r, g, b }: Rgb): string {
  const c = (x: number) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mixes `b` into `a` by `t` (0..1) in sRGB. */
export function mix(a: string, b: string, t: number): string {
  const x = toRgb(a);
  const y = toRgb(b);
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

/** A see-through layer over a solid color, as the eye gets it: 'rgba(r, g, b, a)' (or a hex, which simply covers) over a hex. */
export function over(base: string, layer: string): string {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(layer.trim());
  if (!m) return layer.startsWith('#') ? layer : base;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  return mix(base, toHex({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }), a);
}

/** WCAG relative luminance (0 black .. 1 white). */
export function luminance(hex: string): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const { r, g, b } = toRgb(hex);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const LIGHT_INK = '#111827';
const DARK_INK = '#ecebe5';

/** Light or dark, whichever ink reads better on the background. */
export function schemeOf(bg: string): Scheme {
  return contrast(LIGHT_INK, bg) >= contrast(DARK_INK, bg) ? 'light' : 'dark';
}

/** Pushes a color toward the ink until it reaches `min` contrast on `bg`. */
function readable(color: string, bg: string, ink: string, min: number): string {
  let out = color;
  for (let t = 0.1; contrast(out, bg) < min && t <= 1.001; t += 0.1) out = mix(color, ink, t);
  return out;
}

/** Every color token the UI uses, as CSS custom property name -> value. */
export type Tokens = Record<`--spica-${string}`, string>;

/**
 * The least contrast at which text on the accent stays white. Set so that the built-in dark skin's blue
 * (white on it: 2.43) still takes white; an accent lighter than that takes the dark text.
 */
export const ON_ACCENT_WHITE_MIN = 2.4;

export function deriveTokens(skin: Skin): Tokens {
  const bg = skin.bg;
  const scheme = schemeOf(bg);
  const dark = scheme === 'dark';
  // Very mid-tone backgrounds push the ink all the way to black or white.
  const ink = skin.fixed?.['--spica-ink'] ?? readable(dark ? DARK_INK : LIGHT_INK, bg, dark ? '#ffffff' : '#000000', 7);
  const accent = skin.accent;
  const accentText = readable(accent, bg, ink, 3);
  // Text on the accent (主按钮, 发送): white while white still reads on it (ON_ACCENT_WHITE_MIN), dark only on
  // an accent too light for white. Not "whichever contrasts more": on a mid blue the dark
  // wins by a hair and the button reads as dark text on blue.
  const onAccent = contrast('#ffffff', accent) >= ON_ACCENT_WHITE_MIN ? '#ffffff' : '#0b0d12';
  const danger = dark ? '#f87171' : '#dc2626';
  const warning = dark ? '#fbbf24' : '#b45309';
  const success = dark ? '#4ade80' : '#15803d';
  const derived: Tokens = {
    '--spica-bg': bg,
    // Window chrome: title bar and side panels sit one step away from the main pane
    // (darker in dark mode; a touch grayer in light mode). The built-in skins set their own.
    '--spica-chrome': dark ? mix(bg, '#000000', 0.2) : mix(bg, ink, 0.03),
    '--spica-surface': dark ? mix(bg, ink, 0.04) : mix(bg, '#ffffff', 0.7),
    '--spica-raised': dark ? mix(bg, ink, 0.07) : '#ffffff',
    '--spica-input': dark ? mix(bg, ink, 0.06) : '#ffffff',
    '--spica-border': mix(bg, ink, dark ? 0.12 : 0.11),
    '--spica-border-strong': mix(bg, ink, dark ? 0.22 : 0.2),
    '--spica-hover': mix(bg, ink, dark ? 0.07 : 0.055),
    '--spica-active': mix(bg, ink, dark ? 0.11 : 0.09),
    // What you wrote, in the conversation: a filled block, no border.
    '--spica-bubble': dark ? mix(bg, '#000000', 0.3) : mix(bg, ink, 0.06),
    '--spica-ink': ink,
    '--spica-muted': readable(mix(ink, bg, dark ? 0.36 : 0.4), bg, ink, 4.5),
    '--spica-faint': readable(mix(ink, bg, dark ? 0.56 : 0.6), bg, ink, 2.6),
    '--spica-accent': accent,
    '--spica-accent-text': accentText,
    '--spica-on-accent': onAccent,
    '--spica-accent-soft': mix(bg, accent, dark ? 0.2 : 0.12),
    '--spica-selection': mix(bg, accent, dark ? 0.35 : 0.25),
    '--spica-danger': danger,
    '--spica-danger-soft': mix(bg, danger, dark ? 0.18 : 0.1),
    '--spica-warning': warning,
    '--spica-warning-soft': mix(bg, warning, dark ? 0.18 : 0.12),
    '--spica-success': success,
    '--spica-scrim': dark ? 'rgba(0, 0, 0, 0.5)' : 'rgba(15, 23, 42, 0.28)',
    '--spica-shadow': dark
      ? '0 12px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06)'
      : '0 12px 32px rgba(15, 23, 42, 0.14), 0 0 0 1px rgba(15, 23, 42, 0.06)',
  };
  // Layers the reference sets apart; a derived skin keeps what it had (same as the general token).
  const layers: Tokens = {
    '--spica-divider': derived['--spica-border']!,
    '--spica-placeholder': derived['--spica-faint']!,
    '--spica-input-border': derived['--spica-border-strong']!,
    '--spica-input-shadow': '0 1px 2px rgba(0, 0, 0, 0.04)',
    '--spica-control': derived['--spica-raised']!,
    '--spica-control-hover': derived['--spica-hover']!,
    '--spica-code': derived['--spica-hover']!,
    '--spica-menu': derived['--spica-raised']!,
    '--spica-menu-hover': derived['--spica-hover']!,
  };
  const all: Tokens = { ...derived, ...layers, ...(skin.fixed as Tokens | undefined) };
  // The settings dialog (他 2026-11-12, from Claude's): its sections' column is the deeper of the window's two
  // greys (main pane, chrome), its content the lighter one, whichever way round a skin has them.
  const bgTone = all['--spica-bg']!;
  const chromeTone = all['--spica-chrome']!;
  const [deep, light] = luminance(bgTone) <= luminance(chromeTone) ? [bgTone, chromeTone] : [chromeTone, bgTone];
  return { ...all, '--spica-settings-nav': deep, '--spica-settings-pane': light };
}

/** Picks the skin to show for a choice, given the OS setting and the user's skins. */
export function resolveSkin(choice: SkinChoice, systemDark: boolean, custom: readonly Skin[]): Skin {
  if (choice === 'system') return systemDark ? DARK_SKIN : LIGHT_SKIN;
  return [...BUILTIN_SKINS, ...custom].find((s) => s.id === choice) ?? (systemDark ? DARK_SKIN : LIGHT_SKIN);
}

/** What lies over the whole window just now: the opening animation, a scrim (a dialog, a picture at full size), or nothing. */
export type WindowCover = 'splash' | 'scrim' | null;

/**
 * The minimise, maximise and close buttons are drawn by Windows over the page. Their own background is
 * see-through, so what is under them is the page itself (the title bar, a scrim, the opening animation) and it
 * changes and fades with the page. Windows still draws the three symbols (and its own hover highlight).
 */
export const CAPTION_BACK = '#00000000';

/** The opening animation's text colour (@spica/brand styles/splash.css, --spica-splash-ink). */
export const SPLASH_INK = { dark: '#f1f5f9', light: '#0f172a' } as const;

/** The symbols' colour: the page's muted text, under a scrim as the scrim makes it, over the opening animation its text colour. */
export function captionSymbol(ink: string, scrim: string, cover: WindowCover, dark: boolean): string {
  if (cover === 'splash') return SPLASH_INK[dark ? 'dark' : 'light'];
  if (cover === 'scrim') return over(ink, scrim);
  return ink;
}
