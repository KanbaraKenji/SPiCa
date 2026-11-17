// Zoom of the pages in the built-in browser (web tabs, and local HTML files run as pages): Ctrl + wheel, Ctrl + plus /
// minus and Ctrl + 0 in a page zoom that page only, as a browser does; the app's own zoom (main/index.ts applyZoom)
// is not touched.
//
// Kept per site (the address's origin): two tabs of the same site have the same zoom, another site is at 100%, as in
// a browser. Kept while the app runs, not after it is closed. The steps are the app's own (shared/zoom.ts).
//
// A page is drawn at the app's zoom times its own (a page at 125% in an app at 110% is drawn at 137.5%), and Electron
// sets a page back to the app's zoom whenever the app's changes: appZoomChanged puts each page's own back.
import { DEFAULT_ZOOM, stepZoom } from '../../shared/zoom';

/** The parts of a page's WebContents used here. */
export interface ZoomGuest {
  readonly id: number;
  getURL(): string;
  isDestroyed(): boolean;
  setZoomFactor(factor: number): void;
  on(event: 'zoom-changed', listener: (e: unknown, direction: 'in' | 'out') => void): unknown;
  on(event: 'before-input-event', listener: (e: { preventDefault(): void }, input: ZoomKey) => void): unknown;
  on(event: 'did-navigate' | 'destroyed', listener: () => void): unknown;
}

/** The parts of a key press used here (Electron's Input). */
export interface ZoomKey {
  type: string;
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
}

/**
 * Electron says zoom-changed twice for one notch of a page's wheel (well under a millisecond apart, measured): the
 * second within this many ms, the same way, is the same notch.
 */
const SAME_NOTCH_MS = 5;

/** What a key press does to the page's zoom: Ctrl (⌘) with plus, minus or 0, as the app's own keys (main/index.ts). */
export function zoomKey(input: ZoomKey): 'in' | 'out' | 'reset' | null {
  if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return null;
  if (input.key === '0' || input.code === 'Numpad0') return 'reset';
  if (input.key === '=' || input.key === '+' || input.code === 'NumpadAdd') return 'in';
  if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract') return 'out';
  return null;
}

/**
 * The site a zoom is kept for: the address's origin (a local HTML file's spica-page://<token>, which has none to the
 * URL parser: its scheme and host); '' (none kept) for an empty page.
 */
export function zoomSite(url: string): string {
  try {
    const u = new URL(url);
    if (u.origin !== 'null') return u.origin;
    return u.host ? `${u.protocol}//${u.host}` : '';
  } catch {
    return '';
  }
}

export interface PageZoom {
  /** A page attached: its keys and wheel zoom it. */
  wire(guest: ZoomGuest): void;
  /** The page's own zoom (1 = 100%). */
  zoomOf(wcId: number): number;
  /** One step in or out, or back to 100% (the mark in the address row). */
  step(wcId: number, how: 'in' | 'out' | 'reset'): void;
  /** The app's zoom changed: each page drawn again at the app's zoom times its own. */
  appZoomChanged(): void;
}

export function pageZoom(o: { appZoom(): number; notify(wcId: number, zoom: number): void; now?: () => number }): PageZoom {
  const now = o.now ?? (() => performance.now());
  const bySite = new Map<string, number>();
  const pages = new Map<number, ZoomGuest>();
  const siteOf = (g: ZoomGuest) => zoomSite(g.getURL());
  const own = (g: ZoomGuest) => bySite.get(siteOf(g)) ?? DEFAULT_ZOOM;
  const draw = (g: ZoomGuest) => {
    if (g.isDestroyed()) return;
    g.setZoomFactor(o.appZoom() * own(g));
    o.notify(g.id, own(g));
  };
  const set = (g: ZoomGuest, how: 'in' | 'out' | 'reset') => {
    const site = siteOf(g);
    if (!site) return;
    const next = how === 'reset' ? DEFAULT_ZOOM : stepZoom(own(g), how);
    if (next === DEFAULT_ZOOM) bySite.delete(site);
    else bySite.set(site, next);
    for (const p of pages.values()) if (siteOf(p) === site) draw(p);
  };
  return {
    wire(g) {
      pages.set(g.id, g);
      // Ctrl + wheel in the page (the page does not zoom by itself: Electron leaves it to us).
      let last = { at: -Infinity, direction: '' };
      g.on('zoom-changed', (_e, direction) => {
        const at = now();
        const same = direction === last.direction && at - last.at < SAME_NOTCH_MS;
        last = { at, direction };
        if (!same) set(g, direction);
      });
      g.on('before-input-event', (e, input) => {
        const how = zoomKey(input);
        if (!how) return;
        e.preventDefault();
        set(g, how);
      });
      // Another site keeps its own zoom (Electron would carry the last one over).
      g.on('did-navigate', () => draw(g));
      g.on('destroyed', () => pages.delete(g.id));
    },
    zoomOf(wcId) {
      const g = pages.get(wcId);
      return g ? own(g) : DEFAULT_ZOOM;
    },
    step(wcId, how) {
      const g = pages.get(wcId);
      if (g) set(g, how);
    },
    appZoomChanged() {
      for (const g of pages.values()) draw(g);
    },
  };
}
