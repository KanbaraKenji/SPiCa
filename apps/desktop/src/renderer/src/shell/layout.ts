// Which side panels are docked, given the viewport width in CSS px (already
// divided by the zoom factor) and what the user asked for. Panels that do not
// fit are hidden instead of squeezing the conversation; opening one then shows
// it floating over the main pane.
import { PANEL_LIMITS, type PanelPrefs, type PanelWidths } from '../../../shared/settings';

export const SIDEBAR_WIDTH = PANEL_LIMITS.left.initial;
export const DETAIL_WIDTH = PANEL_LIMITS.right.initial;
// A panel gives way only when even its narrowest does not fit; before that it shrinks.
export const SIDEBAR_MIN = PANEL_LIMITS.left.min;
export const DETAIL_MIN = PANEL_LIMITS.right.min;
/** Narrowest the conversation may get before a panel gives way. */
export const MAIN_MIN_WIDTH = 440;

export type PanelMode = 'docked' | 'hidden' | 'floating';

export interface Layout {
  left: PanelMode;
  right: PanelMode;
}

export type Floating = 'left' | 'right' | null;

export function computeLayout(viewportWidth: number, prefs: PanelPrefs, floating: Floating = null): Layout {
  const leftFits = viewportWidth >= SIDEBAR_MIN + MAIN_MIN_WIDTH;
  const leftDocked = prefs.left && leftFits;
  const rightFits = viewportWidth >= (leftDocked ? SIDEBAR_MIN : 0) + DETAIL_MIN + MAIN_MIN_WIDTH;
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

/**
 * How wide each panel is drawn. Docked panels keep the widths the user chose
 * while the conversation has room; when the window gets narrower they give way
 * in proportion, down to their minimum. A floating panel keeps its width
 * (but never wider than the window allows).
 */
export function panelWidths(viewportWidth: number, layout: Layout, wanted: PanelWidths): PanelWidths {
  const out = { ...wanted };
  const docked = (['left', 'right'] as const).filter((s) => layout[s] === 'docked');
  const room = viewportWidth - MAIN_MIN_WIDTH;
  const total = docked.reduce((n, s) => n + wanted[s], 0);
  if (docked.length && total > room) {
    const scale = room / total;
    for (const s of docked) out[s] = Math.max(PANEL_LIMITS[s].min, Math.floor(wanted[s] * scale));
    // One stopped at its minimum: the other takes what is left (not below its own minimum).
    if (docked.length === 2) {
      const [a, b] = out.left === PANEL_LIMITS.left.min ? (['left', 'right'] as const) : (['right', 'left'] as const);
      if (out[a] === PANEL_LIMITS[a].min) out[b] = Math.max(PANEL_LIMITS[b].min, Math.min(out[b], room - out[a]));
    }
  }
  for (const s of ['left', 'right'] as const) {
    if (layout[s] === 'floating') out[s] = Math.max(PANEL_LIMITS[s].min, Math.min(wanted[s], viewportWidth - 48));
  }
  return out;
}
