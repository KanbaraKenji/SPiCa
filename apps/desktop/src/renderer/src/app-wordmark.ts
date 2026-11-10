// The wordmark for the splash and the sidebar: Spica's own (undefined), or the one
// electron.vite.config.ts drew for the name in deploy.json (__SPICA_WORDMARK__).
import { bannerLayout, WORDMARK, type Wordmark } from '@spica/brand';

declare const __SPICA_WORDMARK__: Wordmark | null | undefined;

export const APP_WORDMARK: Wordmark | undefined = typeof __SPICA_WORDMARK__ === 'undefined' || __SPICA_WORDMARK__ === null ? undefined : __SPICA_WORDMARK__;

/** Props for SpicaBanner / SpicaSplash: none for Spica, so their own default stays in charge. */
export const wordmarkProps: { wordmark?: Wordmark } = APP_WORDMARK ? { wordmark: APP_WORDMARK } : {};

/**
 * The sidebar banner is 22 px high; a long name would push the collapse button
 * out of the narrowest sidebar (200 px), so it gets smaller to stay within 150 px.
 */
export function sidebarBannerHeight(maxHeight = 22, maxWidth = 150): number {
  const L = bannerLayout(APP_WORDMARK ?? WORDMARK);
  return Math.min(maxHeight, Math.floor((maxWidth * L.height) / L.width));
}
