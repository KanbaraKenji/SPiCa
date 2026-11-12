// Which side panels are docked, and how wide, given the viewport width in CSS px (already divided by the zoom
// factor) and what is open. Three panels around the conversation (2026-11-12):
//
//   [sidebar] [conversation] [details] [preview]
//
// - The sidebar (left), Ctrl+B; the user drags its width.
// - The details (详情), Ctrl+Alt+B and the title bar's button; a fixed width. The plugins' panel pages are tabs on
//   top of them.
// - The file preview, always against the window's right edge: open while a file is shown (no saved switch); the
//   user drags its width; it can be laid over the whole conversation (最大化).
//
// Two widths of the conversation: MAIN_ROOM_WIDTH (440), the narrowest it is laid out, and MAIN_SHOWN_MIN (160),
// the least of it that shows while the preview lies over its right part (his words: 「主页面有两个宽度设置，在第一个
// 宽度之前会被一直挤压，过了第一个宽度后，右侧栏遮盖主页内容直到最小尺寸」).
//
// The details are particular (his words: 「详情栏比较特殊，不满足时直接消失而不是遮盖」): they are there only while
// the conversation keeps 440 beside them and the preview at its width; otherwise they are not shown at all (not
// covered, not floated over the window) and come back by themselves when there is room. Their switch is kept; their
// button cannot be pressed meanwhile and says why.
//
// As the window narrows (or a panel is dragged wider), in order:
//   1. the conversation is squeezed (its text wraps again) down to 440;
//   2. the details go;
//   3. the conversation is squeezed to 440 again, then the preview lies over its right part (kept at its 440
//      layout, cut off) until 160 of it shows; dragging the preview stops there;
//   4. the preview gets narrower, down to PREVIEW_MIN (320);
//   5. the preview goes (his words: 「任何位置修改宽度不满足主页第"0"宽度时，预览最先被隐藏」; a file opened then floats
//      it; it comes back when there is room);
//   6. the sidebar shrinks, then goes (pressing its toggle floats it, as before).
// The details go only once the conversation is at 440, not before: the conversation takes whatever room is left, so
// any earlier point would be a width picked out of nothing.
import { PANEL_LIMITS, type PanelWidths } from '../../../shared/settings';

export const SIDEBAR_WIDTH = PANEL_LIMITS.left.initial;
export const SIDEBAR_MIN = PANEL_LIMITS.left.min;
/** The details panel: always this wide (it cannot be dragged). */
export const INFO_WIDTH = 300;
export const PREVIEW_WIDTH = PANEL_LIMITS.preview.initial;
export const PREVIEW_MIN = PANEL_LIMITS.preview.min;
/** The conversation is laid out at least this wide; nothing squeezes it further (the preview covers it instead). */
export const MAIN_ROOM_WIDTH = 440;
/** While the preview lies over the conversation, at least this much of the conversation still shows. */
export const MAIN_SHOWN_MIN = 160;
/** The column of icons left where the sidebar was while it is not docked (styles.css .panel-rail). */
export const RAIL_WIDTH = 52;
/** A floating panel leaves this much of the window uncovered. */
const FLOAT_GAP = 48;

export type PanelMode = 'docked' | 'hidden' | 'floating';

/** The panels that float over the window when they do not fit (the details never do). */
export type Side = 'left' | 'preview';

export interface Layout {
  left: PanelMode;
  preview: PanelMode;
  /** Never 'floating': there, or not at all. */
  info: PanelMode;
}

/** What is open: the saved switches (sidebar, details) and whether a file is shown. */
export interface Open {
  left: boolean;
  info: boolean;
  preview: boolean;
}

/** The panel shown over the window because it did not fit beside the conversation, if any. */
export type Floating = Side | null;

/** The widths the user chose (dragged to) for the two panels that have an edge. */
export type Wanted = Pick<PanelWidths, 'left' | 'preview'>;

const USUAL: Wanted = { left: SIDEBAR_WIDTH, preview: PREVIEW_WIDTH };

export interface Widths {
  left: number;
  preview: number;
  info: number;
  /** How far the docked preview lies over the conversation's right part (0: it only squeezes it). */
  cover: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** The sidebar's width when docked: what was chosen, giving way only to keep the conversation at 440. */
function sidebarWidth(viewportWidth: number, wanted: number): number {
  return clamp(wanted, SIDEBAR_MIN, viewportWidth - MAIN_ROOM_WIDTH);
}

/** The docked preview in the room right of the sidebar: as chosen, at most what leaves 160 of the conversation. */
function previewWidth(room: number, wanted: number): number {
  return clamp(wanted, PREVIEW_MIN, room - MAIN_SHOWN_MIN);
}

export function computeLayout(viewportWidth: number, open: Open, floating: Floating = null, wanted: Wanted = USUAL): Layout {
  const leftDocked = open.left && viewportWidth - MAIN_ROOM_WIDTH >= SIDEBAR_MIN;
  const room = viewportWidth - (leftDocked ? sidebarWidth(viewportWidth, wanted.left) : RAIL_WIDTH);
  // The preview: at its narrowest with the least of the conversation showing, or it is the first to go.
  const previewDocked = open.preview && room >= PREVIEW_MIN + MAIN_SHOWN_MIN;
  const preview = previewDocked ? previewWidth(room, wanted.preview) : 0;
  // The details: only beside the conversation at 440 and the preview at its width; else not there at all.
  const infoDocked = open.info && room - preview - MAIN_ROOM_WIDTH >= INFO_WIDTH;
  const mode = (docked: boolean, side: Side): PanelMode => (docked ? 'docked' : floating === side ? 'floating' : 'hidden');
  return {
    left: mode(leftDocked, 'left'),
    // Closed (no file shown) is closed, whatever was floating.
    preview: open.preview ? mode(previewDocked, 'preview') : 'hidden',
    info: infoDocked ? 'docked' : 'hidden',
  };
}

/** Whether the details have room now (their button can be pressed): as if they were switched on. */
export function infoFits(viewportWidth: number, open: Open, wanted: Wanted = USUAL): boolean {
  return computeLayout(viewportWidth, { ...open, info: true }, null, wanted).info === 'docked';
}

/**
 * How wide each panel is drawn, and how far the preview lies over the conversation. The details are always
 * INFO_WIDTH. A floating panel keeps its width (never wider than the window allows).
 */
export function panelWidths(viewportWidth: number, layout: Layout, wanted: Wanted): Widths {
  const out: Widths = { left: wanted.left, preview: wanted.preview, info: INFO_WIDTH, cover: 0 };
  const leftDocked = layout.left === 'docked';
  if (leftDocked) out.left = sidebarWidth(viewportWidth, wanted.left);
  if (layout.left === 'floating') out.left = Math.max(SIDEBAR_MIN, Math.min(wanted.left, viewportWidth - FLOAT_GAP));
  if (layout.preview === 'docked') {
    const room = viewportWidth - (leftDocked ? out.left : RAIL_WIDTH);
    out.preview = previewWidth(room, wanted.preview);
    // What the conversation would get beside it; under 440 it stays laid out at 440 and the preview covers the rest.
    out.cover = Math.max(0, MAIN_ROOM_WIDTH - (room - out.preview - (layout.info === 'docked' ? INFO_WIDTH : 0)));
  }
  if (layout.preview === 'floating') out.preview = Math.min(wanted.preview, viewportWidth - FLOAT_GAP);
  return out;
}

/** The widest the preview can be dragged to now: until 160 of the conversation shows (the details go on the way). */
export function previewMaxWidth(viewportWidth: number, layout: Layout, widths: Widths): number {
  return Math.max(PREVIEW_MIN, viewportWidth - (layout.left === 'docked' ? widths.left : RAIL_WIDTH) - MAIN_SHOWN_MIN);
}

/**
 * What a toggle button should do. The sidebar: flip its saved switch, or float/unfloat it when it does not fit.
 * The details: flip their switch while they have room; without room nothing (they are never floated or forced in).
 */
export function toggleAction(side: 'left' | 'info', viewportWidth: number, open: Open, floating: Floating, wanted: Wanted = USUAL): { open: Open; floating: Floating } {
  if (side === 'info') {
    if (!infoFits(viewportWidth, open, wanted)) return { open, floating };
    return { open: { ...open, info: !open.info }, floating };
  }
  const now = computeLayout(viewportWidth, open, floating, wanted).left;
  if (now === 'docked') return { open: { ...open, left: false }, floating: null };
  if (now === 'floating') return { open, floating: null };
  // Hidden: dock it if it would fit once switched on, otherwise float it.
  const on = { ...open, left: true };
  if (computeLayout(viewportWidth, on, null, wanted).left === 'docked') return { open: on, floating: null };
  return { open, floating: 'left' };
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
export function previewFloats(viewportWidth: number, open: Open, wanted: Wanted = USUAL): boolean {
  return computeLayout(viewportWidth, { ...open, preview: true }, null, wanted).preview !== 'docked';
}
