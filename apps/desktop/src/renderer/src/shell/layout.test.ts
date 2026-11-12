import { describe, expect, it } from 'vitest';
import {
  computeLayout,
  INFO_WIDTH,
  infoFits,
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
  type Layout,
  type Open,
  type Widths,
} from './layout';

const open = (left: boolean, preview: boolean, info: boolean): Open => ({ left, preview, info });
const all = open(true, true, true);
const wanted = { left: SIDEBAR_WIDTH, preview: PREVIEW_WIDTH };
const d = 'docked';
const h = 'hidden';

/** How much of the conversation shows: what the docked panels leave (the preview's cover is part of that). */
function shown(width: number, layout: Layout, w: Widths): number {
  return width - (layout.left === d ? w.left : RAIL_WIDTH) - (layout.preview === d ? w.preview : 0) - (layout.info === d ? INFO_WIDTH : 0);
}

describe('the numbers the table below is worked out from', () => {
  it('are what the design says', () => {
    expect([SIDEBAR_WIDTH, SIDEBAR_MIN, PREVIEW_WIDTH, PREVIEW_MIN, INFO_WIDTH, MAIN_ROOM_WIDTH, MAIN_SHOWN_MIN, RAIL_WIDTH]).toEqual([264, 200, 640, 320, 300, 440, 160, 52]);
  });
});

// Window width x what is open -> how each panel shows (on screen: sidebar, conversation, details, preview against
// the right edge), how wide it is drawn, how much of the conversation shows, and how far the preview lies over it
// (the conversation stays laid out at 440 under it). "-" for a panel not there.
type Row = [width: number, sidebar: boolean, preview: boolean, details: boolean, layout: [string, string, string], widths: [number | '-', number | '-', number | '-'], conversation: number, cover: number];
const TABLE: Row[] = [
  //  width  left   prev   info    left prev info      left  prev  info   conv  cover
  [480, true, true, true, [h, h, h], ['-', '-', '-'], 428, 0],
  // 700: the preview is the first to go (the sidebar still there).
  [700, true, true, true, [d, h, h], [260, '-', '-'], 440, 0],
  // 744: the preview at its narrowest, 160 of the conversation showing.
  [744, true, true, true, [d, d, h], [264, 320, '-'], 160, 280],
  [900, true, true, true, [d, d, h], [264, 476, '-'], 160, 280],
  // 900 without a preview: the sidebar fits with the conversation at 440 or more, the details do not.
  [900, true, false, true, [d, h, h], [264, '-', '-'], 636, 0],
  [900, false, false, true, [h, h, d], ['-', '-', 300], 548, 0],
  // 1280: no room for the details beside the preview: they are not there; the preview covers a little.
  [1280, true, true, true, [d, d, h], [264, 640, '-'], 376, 64],
  [1280, false, true, true, [h, d, h], ['-', 640, '-'], 588, 0],
  [1280, true, false, true, [d, h, d], [264, '-', 300], 716, 0],
  [1280, false, false, false, [h, h, h], ['-', '-', '-'], 1228, 0],
  [1500, true, true, true, [d, d, h], [264, 640, '-'], 596, 0],
  // 1644: the four side by side, the conversation exactly 440.
  [1644, true, true, true, [d, d, d], [264, 640, 300], 440, 0],
  [1643, true, true, true, [d, d, h], [264, 640, '-'], 739, 0],
  [1920, true, true, true, [d, d, d], [264, 640, 300], 716, 0],
  [1920, true, true, false, [d, d, h], [264, 640, '-'], 1016, 0],
  [1920, false, true, true, [h, d, d], ['-', 640, 300], 928, 0],
  [1920, true, false, true, [d, h, d], [264, '-', 300], 1356, 0],
];

describe('sidebar, conversation, details, preview (against the right edge), by window width', () => {
  it.each(TABLE)('%i wide, sidebar %s, preview %s, details %s', (width, left, preview, info, modes, w, conversation, cover) => {
    const layout = computeLayout(width, open(left, preview, info));
    expect([layout.left, layout.preview, layout.info]).toEqual(modes);
    const widths = panelWidths(width, layout, wanted);
    expect((['left', 'preview', 'info'] as const).map((s) => (layout[s] === d ? widths[s] : '-'))).toEqual(w);
    expect(shown(width, layout, widths)).toBe(conversation);
    expect(widths.cover).toBe(cover);
  });

  it('the details are never covered and never floated: there with the conversation at 440 or more beside them, or not at all', () => {
    for (let width = 480; width <= 2400; width += 3) {
      for (const p of [320, 500, 640, 900, 1400]) {
        for (const [left, pre] of [[true, true], [false, true], [true, false], [false, false]] as const) {
          const layout = computeLayout(width, open(left, pre, true), null, { left: SIDEBAR_WIDTH, preview: p });
          expect(layout.info).not.toBe('floating');
          const w = panelWidths(width, layout, { left: SIDEBAR_WIDTH, preview: p });
          const conv = shown(width, layout, w);
          if (layout.info === d) {
            expect(conv).toBeGreaterThanOrEqual(MAIN_ROOM_WIDTH);
            expect(w.cover).toBe(0);
          }
          if (layout.preview === d) {
            expect(conv).toBeGreaterThanOrEqual(MAIN_SHOWN_MIN);
            if (w.cover) expect(conv + w.cover).toBe(MAIN_ROOM_WIDTH);
          } else if (layout.left === d || layout.info === d) {
            expect(conv).toBeGreaterThanOrEqual(MAIN_ROOM_WIDTH);
          }
        }
      }
    }
  });

  it('as the window narrows: squeezed to 440, the details go, squeezed and covered to 160, the preview at 320, the preview goes, then the sidebar', () => {
    const order: string[] = [];
    let before = computeLayout(2000, all);
    for (let width = 2000; width >= 480; width--) {
      const now = computeLayout(width, all);
      for (const s of ['left', 'preview', 'info'] as const) if (before[s] === d && now[s] !== d) order.push(`${s}@${width}`);
      before = now;
    }
    expect(order).toEqual([
      `info@${SIDEBAR_WIDTH + MAIN_ROOM_WIDTH + INFO_WIDTH + PREVIEW_WIDTH - 1}`, `preview@${SIDEBAR_WIDTH + MAIN_SHOWN_MIN + PREVIEW_MIN - 1}`, `left@${SIDEBAR_MIN + MAIN_ROOM_WIDTH - 1}`,
      // With the sidebar gone (its icon column stays) there is room for the preview again, until that too is short.
      `preview@${RAIL_WIDTH + MAIN_SHOWN_MIN + PREVIEW_MIN - 1}`,
    ]);
    const at = (width: number) => {
      const layout = computeLayout(width, all);
      const w = panelWidths(width, layout, wanted);
      return { conv: shown(width, layout, w), preview: w.preview };
    };
    expect([at(1644).conv, at(1344).conv, at(1064).conv, at(744).preview]).toEqual([440, 440, 160, 320]);
  });

  it('dragging the preview wider: the details go once the conversation would have less than 440; it stops at 160', () => {
    // 1920 - 264 = 1656 right of the sidebar: 1656 - 440 - 300 = 916.
    expect(computeLayout(1920, all, null, { left: SIDEBAR_WIDTH, preview: 916 }).info).toBe(d);
    expect(computeLayout(1920, all, null, { left: SIDEBAR_WIDTH, preview: 917 }).info).toBe(h);
    const layout = computeLayout(1920, all, null, { left: SIDEBAR_WIDTH, preview: 3000 });
    const w = panelWidths(1920, layout, { left: SIDEBAR_WIDTH, preview: 3000 });
    expect(w.preview).toBe(1920 - SIDEBAR_WIDTH - MAIN_SHOWN_MIN);
    expect(previewMaxWidth(1920, layout, w)).toBe(w.preview);
    expect(w.cover).toBe(MAIN_ROOM_WIDTH - MAIN_SHOWN_MIN);
  });

  it('dragging the sidebar wider: the preview gives way, and is the first to go', () => {
    expect(panelWidths(1000, computeLayout(1000, open(true, true, false), null, { left: 440, preview: 900 }), { left: 440, preview: 900 }).preview).toBe(400);
    const tight = computeLayout(900, open(true, true, false), null, { left: 440, preview: 640 });
    expect([tight.left, tight.preview]).toEqual([d, h]);
  });
});

describe('the details button', () => {
  it('with room: switches them on and off', () => {
    expect(toggleAction('info', 1920, all, null)).toEqual({ open: open(true, true, false), floating: null });
    expect(toggleAction('info', 1920, open(true, true, false), null)).toEqual({ open: all, floating: null });
  });
  it('without room: does nothing (they are not floated or forced in), and says so', () => {
    expect(infoFits(1280, all)).toBe(false);
    expect(toggleAction('info', 1280, all, null)).toEqual({ open: all, floating: null });
    expect(toggleAction('info', 1280, open(true, true, false), null)).toEqual({ open: open(true, true, false), floating: null });
    expect(toggleAction('info', 700, open(true, false, false), 'left')).toEqual({ open: open(true, false, false), floating: 'left' });
  });
  it('they come back by themselves when there is room again: closing the preview, or a narrower one', () => {
    expect(computeLayout(1280, open(true, false, true)).info).toBe(d);
    expect(infoFits(1280, all, { left: SIDEBAR_WIDTH, preview: 320 })).toBe(false);
    expect(infoFits(1280, open(false, true, true), { left: SIDEBAR_WIDTH, preview: 488 })).toBe(true);
  });
  it('does not touch the preview', () => {
    expect(toggleAction('info', 1920, open(true, false, true), null).open.preview).toBe(false);
  });
});

describe('floating panels (the sidebar and the preview; the details never float)', () => {
  it('a panel that does not fit is drawn over the window only while it floats; a closed preview never floats', () => {
    expect(computeLayout(600, all, 'left')).toEqual({ left: 'floating', preview: d, info: h });
    expect(computeLayout(480, all, 'preview')).toEqual({ left: h, preview: 'floating', info: h });
    expect(computeLayout(480, open(true, false, true), 'preview').preview).toBe(h);
  });
  it('keeps its width within the window, and a floating preview covers nothing it counts', () => {
    const w = panelWidths(480, computeLayout(480, all, 'preview'), wanted);
    expect([w.preview, w.cover]).toEqual([480 - 48, 0]);
    expect(panelWidths(300, computeLayout(300, all, 'left'), { left: 320, preview: 640 }).left).toBe(300 - 48);
    expect(panelWidths(220, computeLayout(220, all, 'left'), { left: 320, preview: 640 }).left).toBe(SIDEBAR_MIN);
  });
  it('opening a file floats the preview only when it does not fit beside 160 of the conversation', () => {
    expect(previewFloats(SIDEBAR_WIDTH + PREVIEW_MIN + MAIN_SHOWN_MIN, open(true, false, true))).toBe(false);
    expect(previewFloats(SIDEBAR_WIDTH + PREVIEW_MIN + MAIN_SHOWN_MIN - 1, open(true, false, true))).toBe(true);
  });
});

describe('toggleAction for the sidebar', () => {
  it('closes a docked sidebar by saving the switch, docks a closed one again when it fits, floats it when not', () => {
    expect(toggleAction('left', 1920, all, null)).toEqual({ open: open(false, true, true), floating: null });
    expect(toggleAction('left', 1920, open(false, true, true), null)).toEqual({ open: all, floating: null });
    expect(toggleAction('left', 600, open(false, true, true), null)).toEqual({ open: open(false, true, true), floating: 'left' });
  });
});

describe('the sidebar toggle pressed while the sidebar is only slid out', () => {
  const closed = open(false, false, true);
  it('opens it for good: docked when it fits, left out on purpose when it does not', () => {
    expect(toggleFrom('left', 1920, closed, 'left', true)).toEqual({ open: open(true, false, true), floating: null });
    expect(toggleFrom('left', 500, closed, 'left', true)).toEqual({ open: closed, floating: 'left' });
  });
  it('a sidebar left out on purpose (not slid out by resting) still closes on the press', () => {
    expect(toggleFrom('left', 500, closed, 'left', false)).toEqual({ open: closed, floating: null });
    expect(toggleFrom('left', 1920, all, null, false)).toEqual(toggleAction('left', 1920, all, null));
  });
});
