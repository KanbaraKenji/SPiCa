// The context card's colours, taken from the skin's accent.
// Three categories at clearly different lightnesses of the accent; the parts
// inside one step toward the middle colour. An accent that would read as an
// alarm (its hue near the skin's warning or error colour) or as no colour at
// all (grey) gives way to blue, so the card never looks like a warning.

export const CONTEXT_FALLBACK = { light: '#2563eb', dark: '#60a5fa' } as const;

/** #rgb, #rrggbb or rgb()/rgba() to [r, g, b] in 0..255; null for anything else. */
export function parseColor(c: string): [number, number, number] | null {
  const s = c.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((x) => x + x).join('') : hex[1]!;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(s);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

function hueSat([r, g, b]: [number, number, number]): { h: number; s: number } {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0 };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s };
}

const luminance = ([r, g, b]: [number, number, number]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/** Hues closer than this to the warning or error colour read as an alarm. */
const ALARM_GAP = 30;

export interface ContextColours {
  system: string;
  tools: string;
  messages: string;
  /** true: the accent was set aside for blue (alarm-like or grey). */
  fallback: boolean;
}

export function contextColours(t: { accent: string; warning: string; danger: string; bg: string }): ContextColours {
  const bg = parseColor(t.bg);
  const dark = bg ? luminance(bg) < 0.45 : false;
  const acc = parseColor(t.accent);
  const a = acc ? hueSat(acc) : null;
  const alarm = (c: string) => {
    const p = parseColor(c);
    if (!p || !a) return false;
    const o = hueSat(p);
    return o.s > 0.2 && hueGap(a.h, o.h) < ALARM_GAP;
  };
  const fallback = !a || a.s < 0.25 || alarm(t.warning) || alarm(t.danger);
  const base = fallback ? (dark ? CONTEXT_FALLBACK.dark : CONTEXT_FALLBACK.light) : t.accent.trim();
  return {
    system: `color-mix(in oklab, ${base} ${dark ? 68 : 55}%, #000)`,
    tools: base,
    messages: `color-mix(in oklab, ${base} ${dark ? 45 : 38}%, #fff)`,
    fallback,
  };
}
