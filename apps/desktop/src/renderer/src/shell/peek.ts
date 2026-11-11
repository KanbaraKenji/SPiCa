// Sidebar collapsed: resting the pointer on the sidebar's toggle slides the full
// sidebar out over the icon column; leaving the sidebar slides it back. The icons
// of the column do not slide it out: they go straight to their page. The waits
// live here so they can be tested: short to open (a rest, not a pass over the
// button), a little longer to close (a shaky hand does not lose it).
import { useCallback, useEffect, useRef } from 'react';

/** From the pointer resting on the toggle to the sidebar out. */
export const PEEK_OPEN_MS = 100;
/** From the pointer leaving the slid-out sidebar to it going back. */
export const PEEK_CLOSE_MS = 400;

export interface Peek {
  /** The pointer rests on the toggle: open after PEEK_OPEN_MS, unless `shown` (already out) or already waiting. */
  openSoon(shown: boolean): void;
  /** The pointer left the slid-out sidebar: close after PEEK_CLOSE_MS, if `peeking` (opened by resting, not on purpose). */
  closeSoon(peeking: boolean): void;
  /** Stop whatever is waiting (the pointer came back, or a press). */
  cancel(): void;
}

export function usePeek(onOpen: () => void, onClose: () => void): Peek {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = useRef(onOpen);
  const close = useRef(onClose);
  useEffect(() => {
    open.current = onOpen;
    close.current = onClose;
  });
  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const openSoon = useCallback((shown: boolean) => {
    if (timer.current || shown) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      open.current();
    }, PEEK_OPEN_MS);
  }, []);
  const closeSoon = useCallback(
    (peeking: boolean) => {
      cancel();
      if (!peeking) return;
      timer.current = setTimeout(() => {
        // Done waiting: the next rest on the toggle starts a new wait.
        timer.current = null;
        close.current();
      }, PEEK_CLOSE_MS);
    },
    [cancel],
  );
  useEffect(() => cancel, [cancel]);
  return { openSoon, closeSoon, cancel };
}
