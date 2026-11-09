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
  builtin?: boolean;
}

export const LIGHT_SKIN: Skin = { id: 'light', name: '浅色', bg: '#f7f8fa', accent: '#2f7de1', builtin: true };
export const DARK_SKIN: Skin = { id: 'dark', name: '深色', bg: '#15171c', accent: '#62a9ff', builtin: true };
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
const DARK_INK = '#e7eaf0';

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

export function deriveTokens(skin: Skin): Tokens {
  const bg = skin.bg;
  const scheme = schemeOf(bg);
  const dark = scheme === 'dark';
  // Very mid-tone backgrounds push the ink all the way to black or white.
  const ink = readable(dark ? DARK_INK : LIGHT_INK, bg, dark ? '#ffffff' : '#000000', 7);
  const accent = skin.accent;
  const accentText = readable(accent, bg, ink, 3);
  const onAccent = contrast('#ffffff', accent) >= contrast('#0b0d12', accent) ? '#ffffff' : '#0b0d12';
  const danger = dark ? '#f87171' : '#dc2626';
  const warning = dark ? '#fbbf24' : '#b45309';
  const success = dark ? '#4ade80' : '#15803d';
  return {
    '--spica-bg': bg,
    // Window chrome: title bar and side panels sit one step away from the main pane.
    '--spica-chrome': mix(bg, ink, dark ? 0.035 : 0.03),
    '--spica-surface': dark ? mix(bg, ink, 0.05) : mix(bg, '#ffffff', 0.7),
    '--spica-raised': dark ? mix(bg, ink, 0.08) : '#ffffff',
    '--spica-input': dark ? mix(bg, ink, 0.04) : '#ffffff',
    '--spica-border': mix(bg, ink, dark ? 0.12 : 0.11),
    '--spica-border-strong': mix(bg, ink, dark ? 0.22 : 0.2),
    '--spica-hover': mix(bg, ink, dark ? 0.07 : 0.055),
    '--spica-active': mix(bg, ink, dark ? 0.11 : 0.09),
    // What you wrote, in the conversation: a filled block, no border.
    '--spica-bubble': mix(bg, ink, dark ? 0.09 : 0.06),
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
}

/** Picks the skin to show for a choice, given the OS setting and the user's skins. */
export function resolveSkin(choice: SkinChoice, systemDark: boolean, custom: readonly Skin[]): Skin {
  if (choice === 'system') return systemDark ? DARK_SKIN : LIGHT_SKIN;
  return [...BUILTIN_SKINS, ...custom].find((s) => s.id === choice) ?? (systemDark ? DARK_SKIN : LIGHT_SKIN);
}
