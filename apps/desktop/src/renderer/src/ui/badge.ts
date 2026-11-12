// A letter on a colour: what stands for something that has no picture. A plugin without an icon (设置 › 插件)
// and the user's account (the sidebar's bottom row) use the same one.

/** Badge colours: mid tones that carry white text on a light or a dark skin. */
export const BADGE_COLOURS = ['#4f7cff', '#16a37f', '#c2410c', '#7c3aed', '#0e7490', '#b45309', '#be185d', '#4d7c0f', '#1d4ed8', '#9333ea', '#0f766e', '#a16207'];

/** The first character of `text` (a letter in upper case) on the colour `key` always gets. */
export function letterBadge(text: string, key: string): { letter: string; colour: string } {
  const first = [...text.trim()][0] ?? '?';
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return { letter: /[a-z]/i.test(first) ? first.toUpperCase() : first, colour: BADGE_COLOURS[h % BADGE_COLOURS.length]! };
}
