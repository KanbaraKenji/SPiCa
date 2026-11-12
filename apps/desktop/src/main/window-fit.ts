// Whether the window fits the screen area Windows leaves for windows (the work area: the screen less the taskbar).
// A maximized window was seen with its bottom behind the taskbar on one machine and could not be made to do it on
// another; this only writes lines in main's log so the next time shows which step it happened at. Nothing is
// changed on the window.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FitState {
  /** The window's bounds (BrowserWindow.getBounds, DIP). */
  bounds: Rect;
  /** The display the window is on (screen.getDisplayMatching). */
  display: { bounds: Rect; workArea: Rect; scaleFactor: number };
  maximized: boolean;
  fullScreen: boolean;
}

/**
 * How far past the work area a correctly maximized window may still reach, in DIP. Windows places a maximized
 * window with its resize border hanging off every edge of the work area; the border grows with the display scale,
 * so in DIP it stays about the same. Measured on Windows 11 at 125%: GetWindowRect reaches 9 px (7.2 DIP) past each
 * edge of the 2560×1380 work area, and getBounds gives -7,-7 2064x1120 around 0,0 2048x1104 (7 DIP past left and
 * top, 9 past right and bottom once rounded). 8 for the border (8 px at 100%), 2 for rounding. A taskbar is about
 * 48 DIP, so a window behind one is far past this.
 */
export const MAXIMIZED_RING_DIP = 8 + 2;

export interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How far each edge of the window lies past the work area, in DIP (0 when inside). */
export function pastWorkArea(bounds: Rect, area: Rect): Edges {
  const r = (v: number) => Math.max(0, Math.round(v));
  return {
    left: r(area.x - bounds.x),
    top: r(area.y - bounds.y),
    right: r(bounds.x + bounds.width - (area.x + area.width)),
    bottom: r(bounds.y + bounds.height - (area.y + area.height)),
  };
}

/** True when some edge lies further past the work area than the maximized window's ring. */
export function beyondWorkArea(s: FitState): boolean {
  const past = pastWorkArea(s.bounds, s.display.workArea);
  return Math.max(past.left, past.top, past.right, past.bottom) > MAXIMIZED_RING_DIP;
}

const rect = (r: Rect) => `${r.x},${r.y} ${r.width}x${r.height}`;

/** The log line: short when it fits (the first showing only), everything when it does not. */
export function fitLine(event: string, s: FitState): string {
  const state = s.fullScreen ? 'full screen' : s.maximized ? 'maximized' : 'normal';
  if (!beyondWorkArea(s)) return `[spica] window fits the work area (${event}, ${state}, ${rect(s.bounds)} in ${rect(s.display.workArea)})`;
  const p = pastWorkArea(s.bounds, s.display.workArea);
  return (
    `[spica] window past the work area (${event}): window ${rect(s.bounds)}, display ${rect(s.display.bounds)}, ` +
    `work area ${rect(s.display.workArea)}, scale ${s.display.scaleFactor}, ${state}` +
    ` (maximized ${s.maximized}, full screen ${s.fullScreen}); past it by left ${p.left} top ${p.top} right ${p.right} bottom ${p.bottom}`
  );
}

/**
 * Returns check(event): logs the first showing always, any other event only when the window is past the work area,
 * and the same picture only once in a row.
 */
export function watchFit(read: () => FitState | null, log: (line: string) => void): (event: string) => void {
  let last = '';
  return (event) => {
    const s = read();
    if (!s) return;
    const first = event === 'first show';
    if (!first && !beyondWorkArea(s)) {
      last = '';
      return;
    }
    const key = JSON.stringify([s.bounds, s.display, s.maximized, s.fullScreen]);
    if (!first && key === last) return;
    last = key;
    log(fitLine(event, s));
  };
}
