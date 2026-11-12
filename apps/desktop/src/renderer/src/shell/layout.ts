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
// The sidebar and the details are placed as if there were no preview: they give way (are hidden; opening one
// floats it over the window) rather than squeeze the conversation below MAIN_ROOM_WIDTH (440), the details first.
// That is the old 「窗口变窄时不挤对话」.
//
// The preview then takes its width from the right edge (his words: 「一直固定在最右侧，所以信息栏被遮盖」, 「主页面有两个
// 宽度设置，在第一个宽度之前会被一直挤压，过了第一个宽度后，右侧栏遮盖主页内容直到最小尺寸」, 「任何位置修改宽度不满足
// 主页第"0"宽度时，预览最先被隐藏」). Going left, as it gets wider or the window narrower:
//   1. the conversation is squeezed (its text wraps again) down to 440;
//   2. the preview lies over the details (still open, under it; their button shows them over the preview);
//   3. the preview lies over the conversation's right part (kept at its 440 layout, cut off) until MAIN_SHOWN_MIN
//      (160) of it shows; dragging stops there;
//   4. the window narrower still: the preview gets narrower, down to PREVIEW_MIN (320);
//   5. then the preview is the first to go (hidden; a file opened then floats it; it comes back when there is room);
//   6. then the sidebar shrinks and goes, as without a preview.
// The details never come before the conversation's 440: a conversation squeezed to 440 is what makes the preview
// lie over them; if they came first, a conversation that takes all the room left would keep them under the preview
// at any width, and the four would never stand side by side.
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

export type Side = 'left' | 'preview' | 'info';

export interface Layout {
  left: PanelMode;
  preview: PanelMode;
  /** 'floating' also while they have their place but the preview lies over it, and their button showed them. */
  info: PanelMode;
  /**
   * The details keep their place beside the conversation: docked, or shown over the preview from under it (the
   * place stays, empty, so nothing beside it moves while they are over the preview).
   */
  infoPlace: boolean;
}

/** What is open: the saved switches (sidebar, details) and whether a file is shown. */
export interface Open {
  left: boolean;
  info: boolean;
  preview: boolean;
}

/** The panel shown over the window (not fitting beside the conversation, or the details over the preview), if any. */
export type Floating = Side | null;

/** The widths the user chose (dragged to) for the two panels that have an edge. */
export type Wanted = Pick<PanelWidths, 'left' | 'preview'>;

const USUAL: Wanted = { left: SIDEBAR_WIDTH, preview: PREVIEW_WIDTH };

export interface Widths {
  left: number;
  preview: number;
  info: number;
  /**
   * How far the docked preview reaches left over what is beside it: the details first, then the conversation's
   * right part (0: it lies over nothing; the conversation is only squeezed).
   */
  cover: number;
  /** How much of the docked details still shows beside the preview (INFO_WIDTH: all of them). */
  infoShown: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * The sidebar's width when docked: what was chosen, giving way only to keep the conversation at 440 (never for the
 * preview, nor for the details: they give way first).
 */
function sidebarWidth(viewportWidth: number, wanted: number): number {
  return clamp(wanted, SIDEBAR_MIN, viewportWidth - MAIN_ROOM_WIDTH);
}

/** The preview against the right edge, in the room right of the sidebar: its width and what it lies over. */
function previewPlace(room: number, infoInPlace: boolean, wanted: number): { preview: number; cover: number; infoShown: number } {
  const preview = clamp(wanted, PREVIEW_MIN, room - MAIN_SHOWN_MIN);
  const free = room - preview;
  const info = infoInPlace ? INFO_WIDTH : 0;
  return { preview, cover: Math.max(0, MAIN_ROOM_WIDTH + info - free), infoShown: infoInPlace ? clamp(free - MAIN_ROOM_WIDTH, 0, INFO_WIDTH) : 0 };
}

export function computeLayout(viewportWidth: number, open: Open, floating: Floating = null, wanted: Wanted = USUAL): Layout {
  // The sidebar and the details, as if there were no preview; the details give way first.
  const leftDocked = open.left && viewportWidth - MAIN_ROOM_WIDTH >= SIDEBAR_MIN;
  const room = viewportWidth - (leftDocked ? sidebarWidth(viewportWidth, wanted.left) : RAIL_WIDTH);
  const infoFits = open.info && room - MAIN_ROOM_WIDTH >= INFO_WIDTH;
  // The preview: at its narrowest with the least of the conversation showing, or it is the first to go.
  const previewDocked = open.preview && room >= PREVIEW_MIN + MAIN_SHOWN_MIN;
  const covered = previewDocked && infoFits && previewPlace(room, true, wanted.preview).infoShown < INFO_WIDTH;
  const mode = (docked: boolean, side: Side): PanelMode => (docked ? 'docked' : floating === side ? 'floating' : 'hidden');
  return {
    left: mode(leftDocked, 'left'),
    // Closed (no file shown) is closed, whatever was floating.
    preview: open.preview ? mode(previewDocked, 'preview') : 'hidden',
    // Under the preview, their button shows them over it (floating) until a press elsewhere, Esc or the button again.
    info: covered && floating === 'info' ? 'floating' : mode(infoFits, 'info'),
    infoPlace: infoFits,
  };
}

/**
 * How wide each panel is drawn, and how far the preview reaches over what is beside it. The details are always
 * INFO_WIDTH. A floating panel keeps its width (never wider than the window allows).
 */
export function panelWidths(viewportWidth: number, layout: Layout, wanted: Wanted): Widths {
  const out: Widths = { left: wanted.left, preview: wanted.preview, info: INFO_WIDTH, cover: 0, infoShown: 0 };
  const leftDocked = layout.left === 'docked';
  if (leftDocked) out.left = sidebarWidth(viewportWidth, wanted.left);
  if (layout.left === 'floating') out.left = Math.max(SIDEBAR_MIN, Math.min(wanted.left, viewportWidth - FLOAT_GAP));
  const infoInPlace = layout.infoPlace;
  if (layout.info === 'docked') out.infoShown = INFO_WIDTH;
  if (layout.info === 'floating') out.info = Math.min(INFO_WIDTH, viewportWidth - FLOAT_GAP);
  if (layout.preview === 'docked') {
    const placed = previewPlace(viewportWidth - (leftDocked ? out.left : RAIL_WIDTH), infoInPlace, wanted.preview);
    out.preview = placed.preview;
    out.cover = placed.cover;
    if (layout.info === 'docked') out.infoShown = placed.infoShown;
  }
  if (layout.preview === 'floating') out.preview = Math.min(wanted.preview, viewportWidth - FLOAT_GAP);
  return out;
}

/** The widest the preview can be dragged to now: over the details and the conversation until 160 of it shows. */
export function previewMaxWidth(viewportWidth: number, layout: Layout, widths: Widths): number {
  return Math.max(PREVIEW_MIN, viewportWidth - (layout.left === 'docked' ? widths.left : RAIL_WIDTH) - MAIN_SHOWN_MIN);
}

/**
 * What a toggle button should do: flip the saved switch, or float/unfloat a panel that does not show. The details
 * under the preview (any part of them) count as not showing: the press shows them over it, it does not close them.
 */
export function toggleAction(side: 'left' | 'info', viewportWidth: number, open: Open, floating: Floating, wanted: Wanted = USUAL): { open: Open; floating: Floating } {
  const layout = computeLayout(viewportWidth, open, floating, wanted);
  const now = layout[side];
  if (now === 'floating') return { open, floating: null };
  if (now === 'docked') {
    if (side === 'info' && panelWidths(viewportWidth, layout, wanted).infoShown < INFO_WIDTH) return { open, floating: 'info' };
    return { open: { ...open, [side]: false }, floating: null };
  }
  // Hidden: switched on, docked and in sight if it fits so; under the preview, shown over it; else floated.
  const on = { ...open, [side]: true };
  const then = computeLayout(viewportWidth, on, null, wanted);
  if (then[side] !== 'docked') return { open, floating: side };
  if (side === 'info' && panelWidths(viewportWidth, then, wanted).infoShown < INFO_WIDTH) return { open: on, floating: 'info' };
  return { open: on, floating: null };
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

/** The details' button is lit while they are in sight: in their place and not under the preview, or shown over it. */
export function infoInSight(layout: Layout, widths: Widths): boolean {
  return layout.info === 'floating' || (layout.info === 'docked' && widths.infoShown >= INFO_WIDTH);
}
