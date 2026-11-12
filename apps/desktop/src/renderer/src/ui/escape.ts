// Esc closes the topmost open layer, one a press: a menu, a dialog, a card, a slid-out panel, a field being
// renamed in place, a page over the conversation. With none open, Esc goes on to the page (in the message box
// it stops a run). Every layer in the app registers here; none handles Esc on its own.
//
// "Topmost" is the one opened last. A layer and one inside it that open together (a dialog showing its menu at
// once) stack the outer one first, as they are drawn.
//
// Where the focus goes after Esc: back to where it was before whatever opened the layer (a click on a button,
// a key), when closing would leave it on nothing or on the button that opened the layer. So after a menu
// opened from beside the message box closes, the next Esc reaches the box (and stops a run there).
import { useEffect, useRef, useState } from 'react';

interface Layer {
  /** Below every other layer whenever it opened (a page in place of the conversation: what is over it goes first). */
  under: boolean;
  /** Layers that open in one go (one update of the page) share it; a later one is above. */
  batch: number;
  /** Among those, the one rendered first (the outer one) is below. */
  born: number;
  close(): void;
  /** Focused before the press that opened it (what Esc gives the focus back to). */
  before: Element | null;
  /** Focused when it opened (the button pressed to open it). */
  opener: Element | null;
}

const stack: Layer[] = [];
let births = 0;
let batches = 0;
let batchOpen = false;
let listening = false;
/** What had the focus just before the latest press (pointer or key), and when. */
let prior: { el: Element | null; at: number } = { el: null, at: 0 };
/** A press this long before a layer opens still counts as what opened it. */
const OPENED_BY_MS = 1000;

/** The batch of layers opening now: effects of one update run one after another, before any promise job. */
function openingBatch(): number {
  if (!batchOpen) {
    batches++;
    batchOpen = true;
    queueMicrotask(() => {
      batchOpen = false;
    });
  }
  return batches;
}

function above(a: Layer, b: Layer): boolean {
  if (a.under !== b.under) return b.under;
  return a.batch !== b.batch ? a.batch > b.batch : a.born > b.born;
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  e.stopPropagation();
  top.close();
  // After the layer is gone (React applies the change after this event).
  setTimeout(() => giveFocusBack(top), 0);
}

function giveFocusBack(layer: Layer): void {
  const { before, opener } = layer;
  if (!(before instanceof HTMLElement) || !before.isConnected || before === document.body) return;
  const at = document.activeElement;
  const lost = !at || at === document.body || !at.isConnected;
  if (lost || at === opener) before.focus({ preventScroll: true });
}

function notePrior(): void {
  prior = { el: document.activeElement, at: Date.now() };
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('keydown', onKey, true);
  // Seen before the press moves the focus.
  window.addEventListener('pointerdown', notePrior, true);
  window.addEventListener('keydown', notePrior, true);
}

/**
 * While `open`, this layer is above every layer opened before it; Esc then calls `onClose` (one layer a press).
 * `under`: below all the others however late it opened (the inbox, the monitor or a plugin page in the main area).
 */
export function useEscape(open: boolean, onClose: () => void, opts: { under?: boolean } = {}): void {
  const under = opts.under ?? false;
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  // Numbered when first rendered: a parent renders before what is inside it.
  const [born] = useState(() => ++births);
  useEffect(() => {
    if (!open) return;
    const recent = Date.now() - prior.at <= OPENED_BY_MS;
    const layer: Layer = {
      under,
      batch: openingBatch(),
      born,
      close: () => close.current(),
      before: recent ? prior.el : document.activeElement,
      opener: document.activeElement,
    };
    let i = stack.length;
    while (i > 0 && above(stack[i - 1]!, layer)) i--;
    stack.splice(i, 0, layer);
    return () => {
      const at = stack.indexOf(layer);
      if (at >= 0) stack.splice(at, 1);
    };
  }, [open, born, under]);
}

// From the start, so the press that opens the first layer is seen too.
if (typeof window !== 'undefined') listen();

/** How many layers are open (for tests and the app's test hook). */
export function openLayers(): number {
  return stack.length;
}
