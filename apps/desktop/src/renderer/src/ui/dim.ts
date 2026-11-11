// Tells the main process when a scrim covers the window (a dialog, a picture at full size), so the caption
// buttons Windows draws dim with the page instead of staying bright. Every scrim counts: two at once, then one
// closed, is still dimmed.

/** Everything that lays a scrim over the whole window. */
export const SCRIM_SELECTOR = '.scrim, .image-viewer';

/** Reports true when the first scrim appears and false when the last one goes; returns the stop. */
export function watchScrim(doc: Document, report: (on: boolean) => void): () => void {
  let on = Boolean(doc.querySelector(SCRIM_SELECTOR));
  if (on) report(true);
  const observer = new MutationObserver(() => {
    const now = Boolean(doc.querySelector(SCRIM_SELECTOR));
    if (now === on) return;
    on = now;
    report(now);
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    if (on) report(false);
  };
}
