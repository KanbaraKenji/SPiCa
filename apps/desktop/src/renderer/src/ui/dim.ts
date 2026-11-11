// Tells the main process what covers the window: the opening animation, a scrim (a dialog, a picture at
// full size), or nothing. The caption buttons' own background is see-through (the page shows under them
// and changes with it); only their symbols are drawn by Windows, and they take the colour that suits what
// covers the page. Every scrim counts: two at once, then one closed, is still covered.
import type { WindowCover } from '../../../shared/skin';

/** The opening animation while it shows (not once it fades away). */
export const SPLASH_SELECTOR = '.splash-layer:not(.is-skipping)';
/** Everything that lays a scrim over the whole window. */
export const SCRIM_SELECTOR = '.scrim, .image-viewer';

function coverOf(doc: Document): WindowCover {
  if (doc.querySelector(SPLASH_SELECTOR)) return 'splash';
  if (doc.querySelector(SCRIM_SELECTOR)) return 'scrim';
  return null;
}

/**
 * Reports how the page starts, then each change of what covers it; returns the stop. The start is always
 * said: a page reloaded under a dialog never said it closed, and the main process would keep the symbols dim.
 */
export function watchCover(doc: Document, report: (cover: WindowCover) => void): () => void {
  let now = coverOf(doc);
  report(now);
  const observer = new MutationObserver(() => {
    const next = coverOf(doc);
    if (next === now) return;
    now = next;
    report(next);
  });
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  return () => {
    observer.disconnect();
    if (now !== null) report(null);
  };
}
