import { describe, expect, it } from 'vitest';
import { beyondWorkArea, fitLine, MAXIMIZED_RING_DIP, pastWorkArea, watchFit, type FitState } from './window-fit';

// Measured on Windows 11 at 125%, 2560×1440 with the taskbar at the bottom (2048×1152 DIP, work area 2048×1104).
const display = { bounds: { x: 0, y: 0, width: 2048, height: 1152 }, workArea: { x: 0, y: 0, width: 2048, height: 1104 }, scaleFactor: 1.25 };
const normal: FitState = { bounds: { x: 383, y: 151, width: 1282, height: 802 }, display, maximized: false, fullScreen: false };
const maximized: FitState = { bounds: { x: -7, y: -7, width: 2064, height: 1120 }, display, maximized: true, fullScreen: false };
// What the report showed: maximized over the whole screen, the bottom behind the taskbar.
const behindTaskbar: FitState = { bounds: { x: -7, y: -7, width: 2064, height: 1168 }, display, maximized: true, fullScreen: false };

describe('past the work area', () => {
  it('measures each edge in DIP, 0 when inside', () => {
    expect(pastWorkArea(normal.bounds, display.workArea)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(pastWorkArea(maximized.bounds, display.workArea)).toEqual({ left: 7, top: 7, right: 9, bottom: 9 });
    expect(pastWorkArea(behindTaskbar.bounds, display.workArea)).toEqual({ left: 7, top: 7, right: 9, bottom: 57 });
  });

  it("a normal window and a correctly maximized one fit (the border ring Windows hangs off the edges is allowed)", () => {
    expect(beyondWorkArea(normal)).toBe(false);
    expect(beyondWorkArea(maximized)).toBe(false);
  });

  it('a maximized window behind the taskbar does not', () => {
    expect(beyondWorkArea(behindTaskbar)).toBe(true);
  });

  it('any edge counts: a taskbar on the left, at the top, on the right', () => {
    const work = (x: number, y: number, width: number, height: number) => ({ ...display, workArea: { x, y, width, height } });
    expect(beyondWorkArea({ ...maximized, display: work(48, 0, 2000, 1152) })).toBe(true);
    expect(beyondWorkArea({ ...maximized, display: work(0, 48, 2048, 1104) })).toBe(true);
    expect(beyondWorkArea({ ...maximized, display: work(0, 0, 2000, 1152) })).toBe(true);
  });

  it('just past the allowance counts, at it does not', () => {
    const at = (bottom: number): FitState => ({ ...normal, bounds: { x: 0, y: 0, width: 2048, height: 1104 + bottom } });
    expect(beyondWorkArea(at(MAXIMIZED_RING_DIP))).toBe(false);
    expect(beyondWorkArea(at(MAXIMIZED_RING_DIP + 1))).toBe(true);
  });

  it('a full-screen window covers the taskbar and is told as full screen', () => {
    const full: FitState = { ...normal, bounds: display.bounds, maximized: false, fullScreen: true };
    expect(beyondWorkArea(full)).toBe(true);
    expect(fitLine('full screen', full)).toContain('full screen (maximized false, full screen true)');
  });
});

describe('the log line', () => {
  it('is short when the window fits', () => {
    expect(fitLine('first show', normal)).toBe('[spica] window fits the work area (first show, normal, 383,151 1282x802 in 0,0 2048x1104)');
  });

  it('has the bounds, the display, the work area, the scale, the state and the event when it does not', () => {
    expect(fitLine('maximize', behindTaskbar)).toBe(
      '[spica] window past the work area (maximize): window -7,-7 2064x1168, display 0,0 2048x1152, work area 0,0 2048x1104, scale 1.25, maximized' +
        ' (maximized true, full screen false); past it by left 7 top 7 right 9 bottom 57',
    );
  });
});

describe('watching', () => {
  it('logs the first showing always, then only what is past the work area, each picture once in a row', () => {
    const lines: string[] = [];
    let now = normal;
    const check = watchFit(() => now, (l) => lines.push(l));
    check('first show');
    now = maximized;
    check('maximize');
    check('resize while maximized');
    now = behindTaskbar;
    check('display changed');
    check('resize while maximized');
    now = maximized;
    check('display changed');
    now = behindTaskbar;
    check('maximize');
    expect(lines.map((l) => /^\[spica\] window (fits|past) the work area \(([^,)]+)/.exec(l)?.slice(1, 3).join(' '))).toEqual([
      'fits first show',
      'past display changed',
      'past maximize',
    ]);
  });

  it('says nothing once the window is gone', () => {
    const lines: string[] = [];
    watchFit(() => null, (l) => lines.push(l))('first show');
    expect(lines).toEqual([]);
  });
});
