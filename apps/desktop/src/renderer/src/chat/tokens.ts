/**
 * Token counts in short, one way everywhere (the ring, the context card, the
 * model list): 980 → 「980」, 28200 → 「28.2k」, 128000 → 「128k」, 1000000 → 「1M」;
 * windows counted in 1024s read the way providers write them: 131072 → 「128k」,
 * 1048576 → 「1M」.
 */
export function tokenText(n: number): string {
  if (n >= 1024 && n % 1000 !== 0 && n % 1024 === 0) {
    const k = n / 1024;
    return k >= 1024 && k % 1024 === 0 ? `${k / 1024}M` : `${k}k`;
  }
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k`;
  }
  return String(Math.round(n));
}
