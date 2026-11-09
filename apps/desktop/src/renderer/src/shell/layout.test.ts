import { describe, expect, it } from 'vitest';
import { computeLayout, DETAIL_WIDTH, MAIN_MIN_WIDTH, SIDEBAR_WIDTH, toggleAction } from './layout';

const both = { left: true, right: true };
const wide = SIDEBAR_WIDTH + DETAIL_WIDTH + MAIN_MIN_WIDTH;

describe('computeLayout', () => {
  it('docks both panels when there is room', () => {
    expect(computeLayout(wide, both)).toEqual({ left: 'docked', right: 'docked' });
  });
  it('drops the detail panel first, then the sidebar', () => {
    expect(computeLayout(wide - 1, both)).toEqual({ left: 'docked', right: 'hidden' });
    expect(computeLayout(SIDEBAR_WIDTH + MAIN_MIN_WIDTH - 1, both)).toEqual({ left: 'hidden', right: 'hidden' });
  });
  it('respects closed panels', () => {
    expect(computeLayout(wide, { left: false, right: true })).toEqual({ left: 'hidden', right: 'docked' });
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
