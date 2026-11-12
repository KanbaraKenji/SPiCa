import { describe, expect, it } from 'vitest';
import {
  computeLayout,
  INFO_WIDTH,
  MAIN_ROOM_WIDTH,
  MAIN_SHOWN_MIN,
  panelWidths,
  PREVIEW_MIN,
  PREVIEW_WIDTH,
  previewFloats,
  previewMaxWidth,
  RAIL_WIDTH,
  SIDEBAR_MIN,
  SIDEBAR_WIDTH,
  toggleAction,
  toggleFrom,
  type Open,
} from './layout';

const open = (left: boolean, preview: boolean, info: boolean): Open => ({ left, preview, info });
const all = open(true, true, true);
const wanted = { left: SIDEBAR_WIDTH, preview: PREVIEW_WIDTH };
const d = 'docked';
const h = 'hidden';

describe('the numbers the table below is worked out from', () => {
  it('are what the design says', () => {
    expect([SIDEBAR_WIDTH, SIDEBAR_MIN, PREVIEW_WIDTH, PREVIEW_MIN, INFO_WIDTH, MAIN_ROOM_WIDTH, MAIN_SHOWN_MIN, RAIL_WIDTH]).toEqual([264, 200, 640, 320, 300, 440, 160, 52]);
  });
});

// Window width x what is open -> how each panel shows, how wide it is drawn, how much of the conversation shows,
// and how much of it the preview lies over (the conversation stays laid out at 440 under it).
// "-" for a panel not drawn beside the conversation. Without the sidebar its column of icons (52) stays.
const TABLE: [width: number, sidebar: boolean, preview: boolean, details: boolean, layout: [string, string, string], widths: [number | '-', number | '-', number | '-'], shown: number, cover: number][] = [
  //  width  left   prev   info    left prev info      left  prev  info   shown cover
  [480, true, true, true, [h, h, h], ['-', '-', '-'], 428, 0],
  [480, true, false, true, [h, h, h], ['-', '-', '-'], 428, 0],
  [480, false, true, false, [h, h, h], ['-', '-', '-'], 428, 0],
  // 900: the preview keeps its width and lies over the conversation; the sidebar and the details give way to it.
  [900, true, true, true, [h, d, h], ['-', 640, '-'], 208, 232],
  [900, false, true, false, [h, d, h], ['-', 640, '-'], 208, 232],
  // 900 without a preview: the sidebar fits with the conversation at 440 or more, the details do not.
  [900, true, false, true, [d, h, h], [264, '-', '-'], 636, 0],
  [900, false, false, true, [h, h, d], ['-', '-', 300], 548, 0],
  // 1280: the details give way rather than make the preview narrower than chosen (opening them floats them).
  [1280, true, true, true, [d, d, h], [264, 640, '-'], 376, 64],
  [1280, true, true, false, [d, d, h], [264, 640, '-'], 376, 64],
  [1280, false, true, true, [h, d, d], ['-', 640, 300], 288, 152],
  [1280, false, true, false, [h, d, h], ['-', 640, '-'], 588, 0],
  [1280, true, false, true, [d, h, d], [264, '-', 300], 716, 0],
  [1280, false, false, false, [h, h, h], ['-', '-', '-'], 1228, 0],
  // 1500: all three; the conversation is covered past 440.
  [1500, true, true, true, [d, d, d], [264, 640, 300], 296, 144],
  // 1644: all three and the conversation exactly 440, nothing covered.
  [1644, true, true, true, [d, d, d], [264, 640, 300], 440, 0],
  // 1920: everything at the widths chosen.
  [1920, true, true, true, [d, d, d], [264, 640, 300], 716, 0],
  [1920, true, true, false, [d, d, h], [264, 640, '-'], 1016, 0],
  [1920, false, true, true, [h, d, d], ['-', 640, 300], 928, 0],
  [1920, true, false, true, [d, h, d], [264, '-', 300], 1356, 0],
];

describe('three panels around the conversation, by window width', () => {
  it.each(TABLE)('%i wide, sidebar %s, preview %s, details %s', (width, left, preview, info, modes, w, shown, cover) => {
    const layout = computeLayout(width, open(left, preview, info));
    expect([layout.left, layout.preview, layout.info]).toEqual(modes);
    const widths = panelWidths(width, layout, wanted);
    const drawn = (['left', 'preview', 'info'] as const).map((s) => (layout[s] === 'docked' ? widths[s] : '-'));
    expect(drawn).toEqual(w);
    expect(width - drawn.reduce<number>((n, x) => n + (x === '-' ? 0 : x), 0) - (layout.left === 'docked' ? 0 : RAIL_WIDTH)).toBe(shown);
    expect(widths.cover).toBe(cover);
  });

  it('beside a preview the conversation is squeezed to 440, then covered (laid out at 440) until 160 shows; never less', () => {
    for (let width = 532; width <= 2400; width += 3) {
      for (const p of [320, 500, 640, 900, 1400]) {
        for (const [left, info] of [[true, true], [true, false], [false, true], [false, false]] as const) {
          const layout = computeLayout(width, open(left, true, info), null, { left: SIDEBAR_WIDTH, preview: p });
          if (layout.preview !== d) continue;
          const widths = panelWidths(width, layout, { left: SIDEBAR_WIDTH, preview: p });
          const shown = width - (layout.left === d ? widths.left : RAIL_WIDTH) - widths.preview - (layout.info === d ? INFO_WIDTH : 0);
          expect(shown).toBeGreaterThanOrEqual(MAIN_SHOWN_MIN);
          if (widths.cover) expect(shown + widths.cover).toBe(MAIN_ROOM_WIDTH);
          else expect(shown).toBeGreaterThanOrEqual(MAIN_ROOM_WIDTH);
        }
      }
    }
  });

  it('only the preview takes the conversation below 440: without one, it never goes under', () => {
    for (let width = 480; width <= 2000; width += 7) {
      for (const [left, info] of [[true, true], [true, false], [false, true]] as const) {
        const layout = computeLayout(width, open(left, false, info));
        const widths = panelWidths(width, layout, { left: 440, preview: PREVIEW_WIDTH });
        const used = (layout.left === 'docked' ? widths.left : RAIL_WIDTH) + (layout.info === 'docked' ? widths.info : 0);
        if (layout.left === 'docked' || layout.info === 'docked') expect(width - used).toBeGreaterThanOrEqual(MAIN_ROOM_WIDTH);
        expect(widths.cover).toBe(0);
      }
    }
  });

  it('gives way in order as the window narrows: the details first, then the sidebar, the preview last', () => {
    const order: string[] = [];
    let before = computeLayout(2000, all);
    for (let width = 2000; width >= 480; width--) {
      const now = computeLayout(width, all);
      for (const s of ['left', 'preview', 'info'] as const) if (before[s] === 'docked' && now[s] !== 'docked') order.push(`${s}@${width}`);
      before = now;
    }
    expect(order).toEqual([
      `info@${SIDEBAR_WIDTH + PREVIEW_WIDTH + INFO_WIDTH + MAIN_SHOWN_MIN - 1}`,
      `left@${PREVIEW_MIN + MAIN_ROOM_WIDTH + SIDEBAR_MIN - 1}`,
      `preview@${RAIL_WIDTH + PREVIEW_MIN + MAIN_SHOWN_MIN - 1}`,
    ]);
  });

  it('a preview dragged wider stops where only 160 of the conversation shows', () => {
    const layout = computeLayout(1920, all);
    const widths = panelWidths(1920, layout, { left: SIDEBAR_WIDTH, preview: 3000 });
    expect(widths.preview).toBe(1920 - SIDEBAR_WIDTH - INFO_WIDTH - MAIN_SHOWN_MIN);
    expect(widths.cover).toBe(MAIN_ROOM_WIDTH - MAIN_SHOWN_MIN);
    expect(previewMaxWidth(1920, layout, widths)).toBe(widths.preview);
    // With the details closed the preview may take their room too.
    const noInfo = computeLayout(1920, open(true, true, false));
    expect(previewMaxWidth(1920, noInfo, panelWidths(1920, noInfo, wanted))).toBe(1920 - SIDEBAR_WIDTH - MAIN_SHOWN_MIN);
  });

  it('the details come back beside a preview dragged narrower; dragging it wider stops before they would have to go', () => {
    // 1280 - 264 - 300 - 160 = 556
    expect(computeLayout(1280, all, null, { left: SIDEBAR_WIDTH, preview: 556 }).info).toBe(d);
    expect(computeLayout(1280, all, null, { left: SIDEBAR_WIDTH, preview: 557 }).info).toBe(h);
    const layout = computeLayout(1280, all, null, { left: SIDEBAR_WIDTH, preview: 380 });
    const widths = panelWidths(1280, layout, { left: SIDEBAR_WIDTH, preview: 380 });
    const max = previewMaxWidth(1280, layout, widths);
    expect(max).toBe(556);
    expect(computeLayout(1280, all, null, { left: SIDEBAR_WIDTH, preview: max }).info).toBe(d);
  });

  it('the sidebar keeps its chosen width while the preview gives way', () => {
    const layout = computeLayout(1000, open(true, true, false));
    expect(panelWidths(1000, layout, { left: 440, preview: 900 })).toEqual({ left: 440, preview: 400, info: INFO_WIDTH, cover: MAIN_ROOM_WIDTH - MAIN_SHOWN_MIN });
  });
});

describe('floating panels', () => {
  it('a panel that does not fit is drawn over the window only while it floats; a closed preview never floats', () => {
    expect(computeLayout(900, all, 'info')).toEqual({ left: h, preview: d, info: 'floating' });
    expect(computeLayout(900, all, 'left')).toEqual({ left: 'floating', preview: d, info: h });
    expect(computeLayout(480, all, 'preview')).toEqual({ left: h, preview: 'floating', info: h });
    expect(computeLayout(480, open(true, false, true), 'preview').preview).toBe(h);
  });
  it('keeps its width within the window, and a floating preview covers nothing it counts', () => {
    const w = panelWidths(480, computeLayout(480, all, 'preview'), wanted);
    expect([w.preview, w.cover]).toEqual([480 - 48, 0]);
    expect(panelWidths(480, computeLayout(480, all, 'info'), wanted).info).toBe(INFO_WIDTH);
    expect(panelWidths(300, computeLayout(300, all, 'left'), { left: 320, preview: 640 }).left).toBe(300 - 48);
    expect(panelWidths(220, computeLayout(220, all, 'left'), { left: 320, preview: 640 }).left).toBe(SIDEBAR_MIN);
  });
  it('opening a file floats the preview only when it does not fit beside 160 of the conversation', () => {
    expect(previewFloats(RAIL_WIDTH + PREVIEW_MIN + MAIN_SHOWN_MIN, open(true, false, true))).toBe(false);
    expect(previewFloats(RAIL_WIDTH + PREVIEW_MIN + MAIN_SHOWN_MIN - 1, open(true, false, true))).toBe(true);
  });
});

describe('toggleAction', () => {
  it('closes a docked panel by saving the switch', () => {
    expect(toggleAction('left', 1920, all, null)).toEqual({ open: open(false, true, true), floating: null });
    expect(toggleAction('info', 1920, all, null)).toEqual({ open: open(true, true, false), floating: null });
  });
  it('the details button does not touch the preview', () => {
    expect(toggleAction('info', 1920, open(true, true, false), null)).toEqual({ open: all, floating: null });
    expect(toggleAction('info', 1920, open(true, false, true), null).open.preview).toBe(false);
  });
  it('floats a panel that does not fit instead of squeezing the conversation (or the preview)', () => {
    expect(toggleAction('info', 900, all, null)).toEqual({ open: all, floating: 'info' });
    expect(toggleAction('info', 1280, all, null)).toEqual({ open: all, floating: 'info' });
    expect(toggleAction('info', 1280, all, null, { left: SIDEBAR_WIDTH, preview: 380 })).toEqual({ open: open(true, true, false), floating: null });
  });
  it('docks a closed panel again when it fits', () => {
    expect(toggleAction('left', 1920, open(false, true, true), null)).toEqual({ open: all, floating: null });
  });
});

describe('the sidebar toggle pressed while the sidebar is only slid out', () => {
  const closed = open(false, false, true);
  it('opens it for good: docked when it fits, left out on purpose when it does not', () => {
    expect(toggleFrom('left', 1920, closed, 'left', true)).toEqual({ open: open(true, false, true), floating: null });
    expect(toggleFrom('left', 500, closed, 'left', true)).toEqual({ open: closed, floating: 'left' });
  });
  it('a sidebar left out on purpose (not slid out by resting) still closes on the press; the details are not affected', () => {
    expect(toggleFrom('left', 500, closed, 'left', false)).toEqual({ open: closed, floating: null });
    expect(toggleFrom('info', 700, closed, 'info', true)).toEqual({ open: closed, floating: null });
    expect(toggleFrom('left', 1920, all, null, false)).toEqual(toggleAction('left', 1920, all, null));
  });
});
