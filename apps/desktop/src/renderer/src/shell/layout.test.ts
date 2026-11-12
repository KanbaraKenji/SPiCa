import { describe, expect, it } from 'vitest';
import {
  computeLayout,
  INFO_WIDTH,
  infoInSight,
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

/** How much of the conversation shows: what the docked panels leave, less what the preview lies over. */
function shown(width: number, layout: Layout, w: Widths): number {
  const left = layout.left === d ? w.left : RAIL_WIDTH;
  if (layout.preview === d) return width - left - w.preview - w.infoShown;
  return width - left - (layout.info === d ? INFO_WIDTH : 0);
}

describe('the numbers the table below is worked out from', () => {
  it('are what the design says', () => {
    expect([SIDEBAR_WIDTH, SIDEBAR_MIN, PREVIEW_WIDTH, PREVIEW_MIN, INFO_WIDTH, MAIN_ROOM_WIDTH, MAIN_SHOWN_MIN, RAIL_WIDTH]).toEqual([264, 200, 640, 320, 300, 440, 160, 52]);
  });
});

// Window width x what is open -> how each panel shows (left to right on screen: sidebar, conversation, details,
// preview), how wide it is drawn, how much of the conversation and of the details shows, and how far the preview
// (against the right edge) reaches over them. "-" for a panel not drawn in its place.
type Row = [width: number, sidebar: boolean, preview: boolean, details: boolean, layout: [string, string, string], widths: [number | '-', number | '-', number | '-'], conversation: number, details: number | '-', cover: number];
const TABLE: Row[] = [
  //  width  left   prev   info    left prev info      left  prev  info   conv  info  cover
  [480, true, true, true, [h, h, h], ['-', '-', '-'], 428, '-', 0],
  // 700: the preview is the first to go (the sidebar still there).
  [700, true, true, true, [d, h, h], [260, '-', '-'], 440, '-', 0],
  // 744: the preview at its narrowest, 160 of the conversation showing.
  [744, true, true, true, [d, d, h], [264, 320, '-'], 160, '-', 280],
  [900, true, true, true, [d, d, h], [264, 476, '-'], 160, '-', 280],
  // 900 without a preview: the sidebar fits with the conversation at 440 or more, the details do not.
  [900, true, false, true, [d, h, h], [264, '-', '-'], 636, '-', 0],
  [900, false, false, true, [h, h, d], ['-', '-', 300], 548, '-', 0],
  // 1280: the preview lies over all of the details and some of the conversation.
  [1280, true, true, true, [d, d, d], [264, 640, 300], 376, 0, 364],
  [1280, true, true, false, [d, d, h], [264, 640, '-'], 376, '-', 64],
  // 1280 without the sidebar: over half the details; the conversation keeps 440.
  [1280, false, true, true, [h, d, d], ['-', 640, 300], 440, 148, 152],
  [1280, false, true, false, [h, d, h], ['-', 640, '-'], 588, '-', 0],
  [1280, true, false, true, [d, h, d], [264, '-', 300], 716, '-', 0],
  [1280, false, false, false, [h, h, h], ['-', '-', '-'], 1228, '-', 0],
  // 1500: over half the details.
  [1500, true, true, true, [d, d, d], [264, 640, 300], 440, 156, 144],
  // 1644: the four side by side, the conversation exactly 440.
  [1644, true, true, true, [d, d, d], [264, 640, 300], 440, 300, 0],
  [1920, true, true, true, [d, d, d], [264, 640, 300], 716, 300, 0],
  [1920, true, true, false, [d, d, h], [264, 640, '-'], 1016, '-', 0],
  [1920, false, true, true, [h, d, d], ['-', 640, 300], 928, 300, 0],
  [1920, true, false, true, [d, h, d], [264, '-', 300], 1356, '-', 0],
];

describe('sidebar, conversation, details, preview (against the right edge), by window width', () => {
  it.each(TABLE)('%i wide, sidebar %s, preview %s, details %s', (width, left, preview, info, modes, w, conversation, details, cover) => {
    const layout = computeLayout(width, open(left, preview, info));
    expect([layout.left, layout.preview, layout.info]).toEqual(modes);
    const widths = panelWidths(width, layout, wanted);
    expect((['left', 'preview', 'info'] as const).map((s) => (layout[s] === d ? widths[s] : '-'))).toEqual(w);
    expect(shown(width, layout, widths)).toBe(conversation);
    expect(layout.info === d && layout.preview === d ? widths.infoShown : '-').toBe(details);
    expect(widths.cover).toBe(cover);
  });

  it('going left the preview squeezes the conversation to 440, then lies over the details, then over the conversation until 160 shows', () => {
    const steps: string[] = [];
    let before = '';
    for (let p = 320; p <= 2000; p++) {
      const layout = computeLayout(1920, all, null, { left: SIDEBAR_WIDTH, preview: p });
      const w = panelWidths(1920, layout, { left: SIDEBAR_WIDTH, preview: p });
      const conv = shown(1920, layout, w);
      const now = w.cover === 0 ? 'squeeze' : w.infoShown > 0 || conv === MAIN_ROOM_WIDTH ? 'over details' : conv > MAIN_SHOWN_MIN ? 'over conversation' : 'stop';
      if (now !== before) steps.push(`${now}@${w.preview}`);
      before = now;
    }
    // 1920 - 264 = 1656 right of the sidebar: 1656 - 440 - 300 = 916, 1656 - 440 = 1216, 1656 - 160 = 1496.
    expect(steps).toEqual(['squeeze@320', 'over details@917', 'over conversation@1217', 'stop@1496']);
  });

  it('the conversation is never laid out under 440, never shows under 160 beside a preview, and not under 440 without one', () => {
    for (let width = 480; width <= 2400; width += 3) {
      for (const p of [320, 500, 640, 900, 1400]) {
        for (const [left, info, pre] of [[true, true, true], [true, false, true], [false, true, true], [true, true, false], [false, true, false]] as const) {
          const layout = computeLayout(width, open(left, pre, info), null, { left: SIDEBAR_WIDTH, preview: p });
          const w = panelWidths(width, layout, { left: SIDEBAR_WIDTH, preview: p });
          const conv = shown(width, layout, w);
          if (layout.preview === d) {
            expect(conv).toBeGreaterThanOrEqual(MAIN_SHOWN_MIN);
            // What the preview lies over, plus what shows, is the conversation's 440 and the details in their place.
            if (w.cover) expect(conv + w.infoShown + w.cover).toBe(MAIN_ROOM_WIDTH + (layout.info === d ? INFO_WIDTH : 0));
          } else if (layout.left === d || layout.info === d) {
            expect(conv).toBeGreaterThanOrEqual(MAIN_ROOM_WIDTH);
          }
        }
      }
    }
  });

  it('as the window narrows: squeezed to 440, the details covered, 160 left, the preview at 320, then the preview goes first, then the sidebar', () => {
    const at = (width: number) => {
      const layout = computeLayout(width, all);
      const w = panelWidths(width, layout, wanted);
      return { layout, w, conv: shown(width, layout, w) };
    };
    expect(at(1644).conv).toBe(440);
    expect(at(1644).w.infoShown).toBe(300);
    expect(at(1344).w.infoShown).toBe(0);
    expect(at(1344).conv).toBe(440);
    expect(at(1064).conv).toBe(160);
    expect(at(1064).w.preview).toBe(640);
    expect(at(744).w.preview).toBe(320);
    expect(at(743).layout.preview).toBe(h);
    expect(at(743).layout.left).toBe(d);
    expect(at(639).layout.left).toBe(h);
  });

  it('dragging the sidebar wider: the preview gives way, and is the first to go', () => {
    expect(panelWidths(1000, computeLayout(1000, open(true, true, false), null, { left: 440, preview: 900 }), { left: 440, preview: 900 }).preview).toBe(400);
    const tight = computeLayout(900, open(true, true, false), null, { left: 440, preview: 640 });
    expect([tight.left, tight.preview]).toEqual([d, h]);
  });

  it('the preview is dragged as far as 160 of the conversation showing, over the details too', () => {
    const layout = computeLayout(1920, all);
    const w = panelWidths(1920, layout, { left: SIDEBAR_WIDTH, preview: 3000 });
    expect(w.preview).toBe(1920 - SIDEBAR_WIDTH - MAIN_SHOWN_MIN);
    expect(previewMaxWidth(1920, layout, w)).toBe(w.preview);
    expect([w.infoShown, w.cover]).toEqual([0, MAIN_ROOM_WIDTH + INFO_WIDTH - MAIN_SHOWN_MIN]);
  });
});

describe('the details under the preview', () => {
  it('stay open; their button shows them over the preview, and the press again, Esc or a press elsewhere puts them back under', () => {
    expect(toggleAction('info', 1280, all, null)).toEqual({ open: all, floating: 'info' });
    expect(computeLayout(1280, all, 'info').info).toBe('floating');
    // Their place stays while they are over the preview: nothing beside it moves.
    const under = computeLayout(1280, all);
    const over = computeLayout(1280, all, 'info');
    expect(over.infoPlace).toBe(true);
    expect(panelWidths(1280, over, wanted).cover).toBe(panelWidths(1280, under, wanted).cover);
    expect(toggleAction('info', 1280, all, 'info')).toEqual({ open: all, floating: null });
    // Only half under it counts the same.
    expect(toggleAction('info', 1500, all, null)).toEqual({ open: all, floating: 'info' });
  });
  it('switched on while the preview would lie over them: on, and shown over it', () => {
    expect(toggleAction('info', 1280, open(true, true, false), null)).toEqual({ open: all, floating: 'info' });
  });
  it('in sight beside the preview: the button closes them; the button is lit only while they are in sight', () => {
    expect(toggleAction('info', 1920, all, null)).toEqual({ open: open(true, true, false), floating: null });
    const lit = (width: number, floating: 'info' | null = null) => {
      const layout = computeLayout(width, all, floating);
      return infoInSight(layout, panelWidths(width, layout, wanted));
    };
    expect([lit(1920), lit(1500), lit(1280), lit(1280, 'info')]).toEqual([true, false, false, true]);
  });
  it('closing the preview brings them back in their place', () => {
    expect(computeLayout(1280, open(true, false, true)).info).toBe(d);
  });
});

describe('floating panels', () => {
  it('a panel that does not fit is drawn over the window only while it floats; a closed preview never floats', () => {
    expect(computeLayout(900, all, 'info')).toEqual({ left: d, preview: d, info: 'floating', infoPlace: false });
    expect(computeLayout(600, all, 'left')).toEqual({ left: 'floating', preview: d, info: h, infoPlace: false });
    expect(computeLayout(480, all, 'preview')).toEqual({ left: h, preview: 'floating', info: h, infoPlace: false });
    expect(computeLayout(480, open(true, false, true), 'preview').preview).toBe(h);
  });
  it('keeps its width within the window, and a floating preview lies over nothing it counts', () => {
    const w = panelWidths(480, computeLayout(480, all, 'preview'), wanted);
    expect([w.preview, w.cover]).toEqual([480 - 48, 0]);
    expect(panelWidths(480, computeLayout(480, all, 'info'), wanted).info).toBe(INFO_WIDTH);
    expect(panelWidths(300, computeLayout(300, all, 'left'), { left: 320, preview: 640 }).left).toBe(300 - 48);
    expect(panelWidths(220, computeLayout(220, all, 'left'), { left: 320, preview: 640 }).left).toBe(SIDEBAR_MIN);
  });
  it('opening a file floats the preview only when it does not fit beside 160 of the conversation', () => {
    expect(previewFloats(SIDEBAR_WIDTH + PREVIEW_MIN + MAIN_SHOWN_MIN, open(true, false, true))).toBe(false);
    expect(previewFloats(SIDEBAR_WIDTH + PREVIEW_MIN + MAIN_SHOWN_MIN - 1, open(true, false, true))).toBe(true);
  });
});

describe('toggleAction', () => {
  it('closes a docked panel by saving the switch', () => {
    expect(toggleAction('left', 1920, all, null)).toEqual({ open: open(false, true, true), floating: null });
  });
  it('the details button does not touch the preview', () => {
    expect(toggleAction('info', 1920, open(true, true, false), null)).toEqual({ open: all, floating: null });
    expect(toggleAction('info', 1920, open(true, false, true), null).open.preview).toBe(false);
  });
  it('floats a panel that does not fit instead of squeezing the conversation', () => {
    expect(toggleAction('info', 900, all, null)).toEqual({ open: all, floating: 'info' });
    expect(toggleAction('info', 900, all, 'info')).toEqual({ open: all, floating: null });
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
