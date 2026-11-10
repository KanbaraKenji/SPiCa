/** Token counts in k: 28200 -> 「28.2k」, 160000 -> 「160k」, 980 -> 「980」. */
export function tokenText(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
}
