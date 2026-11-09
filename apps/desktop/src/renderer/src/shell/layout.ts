// Which side panels are docked, given the viewport width in CSS px (already
// divided by the zoom factor) and what the user asked for. Panels that do not
// fit are hidden instead of squeezing the conversation; opening one then shows
// it floating over the main pane.
import type { PanelPrefs } from '../../../shared/settings';

export const SIDEBAR_WIDTH = 264;
export const DETAIL_WIDTH = 300;
/** Narrowest the conversation may get before a panel gives way. */
export const MAIN_MIN_WIDTH = 440;

export type PanelMode = 'docked' | 'hidden' | 'floating';

export interface Layout {
  left: PanelMode;
  right: PanelMode;
}

export type Floating = 'left' | 'right' | null;

export function computeLayout(viewportWidth: number, prefs: PanelPrefs, floating: Floating = null): Layout {
  const leftFits = viewportWidth >= SIDEBAR_WIDTH + MAIN_MIN_WIDTH;
  const leftDocked = prefs.left && leftFits;
  const rightFits = viewportWidth >= (leftDocked ? SIDEBAR_WIDTH : 0) + DETAIL_WIDTH + MAIN_MIN_WIDTH;
  const rightDocked = prefs.right && rightFits;
  return {
    left: leftDocked ? 'docked' : floating === 'left' ? 'floating' : 'hidden',
    right: rightDocked ? 'docked' : floating === 'right' ? 'floating' : 'hidden',
  };
}

/** What a toggle button should do: flip the saved preference, or float/unfloat a panel that does not fit. */
export function toggleAction(
  side: 'left' | 'right',
  viewportWidth: number,
  prefs: PanelPrefs,
  floating: Floating,
): { prefs: PanelPrefs; floating: Floating } {
  const now = computeLayout(viewportWidth, prefs, floating)[side];
  if (now === 'docked') return { prefs: { ...prefs, [side]: false }, floating: null };
  if (now === 'floating') return { prefs, floating: null };
  // Hidden: dock it if it would fit once enabled, otherwise float it.
  const wanted = { ...prefs, [side]: true };
  if (computeLayout(viewportWidth, wanted)[side] === 'docked') return { prefs: wanted, floating: null };
  return { prefs, floating: side };
}
