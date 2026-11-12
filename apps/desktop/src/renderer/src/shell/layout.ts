// Which side panels are docked, and how wide, given the viewport width in CSS px (already divided by the zoom
// factor) and what is open. Three panels around the conversation (2026-11-12):
//
//   [sidebar] [conversation] [preview] [details]
//
// - The sidebar (left), Ctrl+B; the user drags its width.
// - The file preview, next to the conversation: open while a file is shown (no saved switch); the user drags its
//   width, it can be laid over the conversation (最大化). The plugins' panel pages stay with the details.
// - The details (详情), at the window's right edge under its title-bar button, Ctrl+Alt+B; a fixed width.
//
// Two widths of the conversation:
// - MAIN_ROOM_WIDTH (440): the sidebar and the details give way (are hidden; opening one floats it over the
//   window) rather than leave the conversation less than this, counting the preview at its narrowest. This is the
//   old 「窗口变窄时不挤对话」.
// - MAIN_MIN_WIDTH (320): the floor. Only the preview takes the conversation below 440, by its own width (what the
//   user dragged it to, or its usual width); it stops at this floor.
// Who gives way as the window narrows: the details first (as soon as they no longer fit beside the preview at the
// width chosen for it), then the preview shrinks to its narrowest, then the sidebar shrinks and goes, the preview
// last. So a file always gets the width chosen for it before the details get theirs.
import { PANEL_LIMITS, type PanelWidths } from '../../../shared/settings';

export const SIDEBAR_WIDTH = PANEL_LIMITS.left.initial;
// A panel gives way only when even its narrowest does not fit; before that it shrinks.
export const SIDEBAR_MIN = PANEL_LIMITS.left.min;
/** The details panel: always this wide (it cannot be dragged). */
export const INFO_WIDTH = 300;
export const PREVIEW_WIDTH = PANEL_LIMITS.preview.initial;
export const PREVIEW_MIN = PANEL_LIMITS.preview.min;
/** Narrowest the conversation ever gets: only the preview takes it this far. */
export const MAIN_MIN_WIDTH = 320;
/** The sidebar and the details give way rather than leave the conversation narrower than this. */
export const MAIN_ROOM_WIDTH = 440;
/** The column of icons left where the sidebar was while it is not docked (styles.css .panel-rail). */
export const RAIL_WIDTH = 52;
/** A floating panel leaves this much of the window uncovered. */
const FLOAT_GAP = 48;

export type PanelMode = 'docked' | 'hidden' | 'floating';

export type Side = 'left' | 'preview' | 'info';

export interface Layout {
  left: PanelMode;
  preview: PanelMode;
  info: PanelMode;
}

/** What is open: the saved switches (sidebar, details) and whether a file is shown. */
export interface Open {
  left: boolean;
  info: boolean;
  preview: boolean;
}

/** The panel shown over the window because it did not fit beside the conversation, if any (one at a time). */
export type Floating = Side | null;

/** The widths the user chose (dragged to) for the two panels that have an edge. */
export type Wanted = Pick<PanelWidths, 'left' | 'preview'>;

const USUAL: Wanted = { left: SIDEBAR_WIDTH, preview: PREVIEW_WIDTH };

export function computeLayout(viewportWidth: number, open: Open, floating: Floating = null, wanted: Wanted = USUAL): Layout {
  // The sidebar: at its narrowest, with a shown file's preview at its narrowest and the conversation at 440.
  const leftDocked = open.left && viewportWidth - (open.preview ? PREVIEW_MIN : 0) - MAIN_ROOM_WIDTH >= SIDEBAR_MIN;
  // What is left right of the sidebar (or of the icon column that stays when it is not docked).
  const rest = viewportWidth - (leftDocked ? SIDEBAR_MIN : RAIL_WIDTH);
  // The preview is the last to give way: it only needs its narrowest beside the conversation's floor.
  const previewDocked = open.preview && rest >= PREVIEW_MIN + MAIN_MIN_WIDTH;
  // The details: room with the preview at its narrowest and the conversation at 440; and, beside a preview, room
  // with the preview at the width chosen for it (the details give way before the preview gets narrower than that).
  const room = rest - (previewDocked ? PREVIEW_MIN : 0) - MAIN_ROOM_WIDTH;
  const besidePreview = !previewDocked || viewportWidth - (leftDocked ? Math.max(SIDEBAR_MIN, wanted.left) : RAIL_WIDTH) - Math.max(PREVIEW_MIN, wanted.preview) - MAIN_MIN_WIDTH >= INFO_WIDTH;
  const infoDocked = open.info && room >= INFO_WIDTH && besidePreview;
  const mode = (docked: boolean, side: Side): PanelMode => (docked ? 'docked' : floating === side ? 'floating' : 'hidden');
  return {
    left: mode(leftDocked, 'left'),
    // Closed (no file shown) is closed, whatever was floating.
    preview: open.preview ? mode(previewDocked, 'preview') : 'hidden',
    info: mode(infoDocked, 'info'),
  };
}

/** What a toggle button should do: flip the saved switch, or float/unfloat a panel that does not fit. */
export function toggleAction(side: 'left' | 'info', viewportWidth: number, open: Open, floating: Floating, wanted: Wanted = USUAL): { open: Open; floating: Floating } {
  const now = computeLayout(viewportWidth, open, floating, wanted)[side];
  if (now === 'docked') return { open: { ...open, [side]: false }, floating: null };
  if (now === 'floating') return { open, floating: null };
  // Hidden: dock it if it would fit once switched on, otherwise float it.
  const on = { ...open, [side]: true };
  if (computeLayout(viewportWidth, on, null, wanted)[side] === 'docked') return { open: on, floating: null };
  return { open, floating: side };
}

/**
 * The sidebar's toggle pressed while the sidebar is only slid out over the icon column (opened by resting on
 * the toggle, not on purpose): the press means "open it", so it acts as on a closed sidebar: docked when it
 * fits, else left out on purpose. Without this the press would take the slid-out sidebar for an open one and
 * close it, and resting on the button would slide it out again: pressing never opened it.
 */
export function toggleFrom(side: 'left' | 'info', viewportWidth: number, open: Open, floating: Floating, peeking: boolean, wanted: Wanted = USUAL): { open: Open; floating: Floating } {
  return toggleAction(side, viewportWidth, open, side === 'left' && peeking && floating === 'left' ? null : floating, wanted);
}

/** Opening a file: the preview docked when it fits, else over the window. */
export function previewFloats(viewportWidth: number, open: Open): boolean {
  return computeLayout(viewportWidth, { ...open, preview: true }).preview !== 'docked';
}


export interface Widths {
  left: number;
  preview: number;
  info: number;
}

/**
 * How wide each panel is drawn. The details are always INFO_WIDTH. The sidebar and the preview keep the widths
 * the user chose while there is room; when the window gets narrower, the preview gives way first (down to its
 * narrowest, the conversation at MAIN_MIN_WIDTH), then the sidebar (down to its narrowest). Without a preview the
 * sidebar keeps the conversation at MAIN_ROOM_WIDTH. A floating panel keeps its width (never wider than the
 * window allows).
 */
export function panelWidths(viewportWidth: number, layout: Layout, wanted: Wanted): Widths {
  const info = layout.info === 'floating' ? Math.min(INFO_WIDTH, viewportWidth - FLOAT_GAP) : INFO_WIDTH;
  const out: Widths = { left: wanted.left, preview: wanted.preview, info };
  const leftDocked = layout.left === 'docked';
  const fixed = (layout.info === 'docked' ? INFO_WIDTH : 0) + (leftDocked ? 0 : RAIL_WIDTH);
  if (layout.preview === 'docked') {
    const room = viewportWidth - fixed - MAIN_MIN_WIDTH;
    const left = leftDocked ? wanted.left : 0;
    out.preview = Math.max(PREVIEW_MIN, Math.min(wanted.preview, room - left));
    if (leftDocked) out.left = Math.max(SIDEBAR_MIN, Math.min(wanted.left, room - out.preview));
  } else if (leftDocked) {
    out.left = Math.max(SIDEBAR_MIN, Math.min(wanted.left, viewportWidth - fixed - MAIN_ROOM_WIDTH));
  }
  if (layout.left === 'floating') out.left = Math.max(SIDEBAR_MIN, Math.min(wanted.left, viewportWidth - FLOAT_GAP));
  if (layout.preview === 'floating') out.preview = Math.min(wanted.preview, viewportWidth - FLOAT_GAP);
  return out;
}

/** The widest the preview can be dragged to now: the conversation stops at MAIN_MIN_WIDTH. */
export function previewMaxWidth(viewportWidth: number, layout: Layout, widths: Widths): number {
  const others = (layout.left === 'docked' ? widths.left : RAIL_WIDTH) + (layout.info === 'docked' ? INFO_WIDTH : 0);
  return Math.max(PREVIEW_MIN, viewportWidth - others - MAIN_MIN_WIDTH);
}
