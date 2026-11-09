import { describe, expect, it } from 'vitest';
import { computeLayout, DETAIL_MIN, DETAIL_WIDTH, MAIN_MIN_WIDTH, panelWidths, SIDEBAR_MIN, SIDEBAR_WIDTH, toggleAction } from './layout';

const both = { left: true, right: true };
const wide = SIDEBAR_WIDTH + DETAIL_WIDTH + MAIN_MIN_WIDTH;

describe('computeLayout', () => {
  it('docks both panels when there is room', () => {
    expect(computeLayout(wide, both)).toEqual({ left: 'docked', right: 'docked' });
  });
  it('drops the detail panel first, then the sidebar, once even their narrowest does not fit', () => {
    // Narrower than the chosen widths: both still docked (they shrink, see panelWidths).
    expect(computeLayout(wide - 1, both)).toEqual({ left: 'docked', right: 'docked' });
    expect(computeLayout(SIDEBAR_MIN + DETAIL_MIN + MAIN_MIN_WIDTH - 1, both)).toEqual({ left: 'docked', right: 'hidden' });
    expect(computeLayout(SIDEBAR_MIN + MAIN_MIN_WIDTH - 1, both)).toEqual({ left: 'hidden', right: 'hidden' });
  });
  it('respects closed panels', () => {
    expect(computeLayout(wide, { left: false, right: true })).toEqual({ left: 'hidden', right: 'docked' });
  });
});

describe('panelWidths', () => {
  const wanted = { left: 320, right: 400 };
  it('keeps the chosen widths while the conversation has room', () => {
    expect(panelWidths(320 + 400 + MAIN_MIN_WIDTH + 100, { left: 'docked', right: 'docked' }, wanted)).toEqual(wanted);
  });
  it('gives way in proportion when the window narrows, never below the minimum', () => {
    const w = panelWidths(1000, { left: 'docked', right: 'docked' }, wanted);
    expect(w.left + w.right).toBeLessThanOrEqual(1000 - MAIN_MIN_WIDTH);
    expect(w.left / w.right).toBeCloseTo(320 / 400, 1);
    const tight = panelWidths(SIDEBAR_MIN + DETAIL_MIN + MAIN_MIN_WIDTH, { left: 'docked', right: 'docked' }, wanted);
    expect(tight).toEqual({ left: SIDEBAR_MIN, right: DETAIL_MIN });
  });
  it('a floating panel keeps its width within the window', () => {
    expect(panelWidths(500, { left: 'floating', right: 'hidden' }, wanted).left).toBe(320);
    expect(panelWidths(300, { left: 'floating', right: 'hidden' }, wanted).left).toBe(300 - 48);
    expect(panelWidths(220, { left: 'floating', right: 'hidden' }, wanted).left).toBe(SIDEBAR_MIN);
  });
});

describe('toggleAction', () => {
  it('closes a docked panel by saving the preference', () => {
    expect(toggleAction('left', wide, both, null)).toEqual({ prefs: { left: false, right: true }, floating: null });
  });
  it('floats a panel that does not fit instead of squeezing the conversation', () => {
    expect(toggleAction('right', 800, both, null)).toEqual({ prefs: both, floating: 'right' });
    expect(toggleAction('right', 800, both, 'right')).toEqual({ prefs: both, floating: null });
  });
  it('docks a closed panel again when it fits', () => {
    expect(toggleAction('left', wide, { left: false, right: true }, null)).toEqual({ prefs: both, floating: null });
  });
});
