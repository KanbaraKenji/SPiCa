// A page's own zoom, just after it changed (Ctrl + wheel, Ctrl + plus / minus / 0 in the page, the mark itself;
// main/browser/page-zoom.ts): grey text inside the end of the address box (or in a run HTML file's row), gone
// ZOOM_MARK_MS after the last change, at once (no fade), whatever the zoom; the next change shows it again. Pressed
// while it shows: back to 100%. It sits in room kept for it (styles.css .zoom-mark), so nothing moves when it comes
// or goes. A screen reader hears the new zoom; nothing is left for it once the mark is gone.
import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge } from '../../../shared/bridge';
import { zoomLabel } from '../../../shared/zoom';
import { t } from '../../../shared/i18n';

export type PageZoomBridge = Pick<DesktopBridge['browser'], 'zoom' | 'onZoom'>;

/** How long the mark stays after the last change (ms). */
export const ZOOM_MARK_MS = 1500;

export function ZoomMark({ zoom: bridge, wcId }: { zoom: PageZoomBridge; wcId: number | null }) {
  // The zoom just set, while it shows; null: nothing shown.
  const [shown, setShown] = useState<{ wcId: number; value: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The pointer on the mark: it stays (to be pressed), and goes ZOOM_MARK_MS after the pointer leaves.
  const over = useRef(false);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const later = () => {
    stop();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!over.current) setShown(null);
    }, ZOOM_MARK_MS);
  };
  useEffect(() => {
    if (wcId === null) return undefined;
    const off = bridge.onZoom((z) => {
      if (z.wcId !== wcId || !z.stepped) return;
      setShown({ wcId, value: z.zoom });
      later();
    });
    return () => {
      off();
      stop();
      over.current = false;
      setShown(null);
    };
    // later / stop only touch the ref and the state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, wcId]);
  const value = shown && shown.wcId === wcId ? shown.value : null;
  const label = value === null ? '' : zoomLabel(value);
  return (
    <>
      {/* Said once when it changes (polite); empty once the mark is gone. */}
      <span className="visually-hidden" aria-live="polite">
        {value === null ? '' : t('缩放 {zoom}', { zoom: label })}
      </span>
      {value === null || wcId === null ? null : (
        <button
          type="button"
          className="zoom-mark num"
          tabIndex={-1}
          onPointerEnter={() => {
            over.current = true;
          }}
          onPointerLeave={() => {
            over.current = false;
            later();
          }}
          onClick={() => void bridge.zoom(wcId, 'reset')}
          title={t('重置缩放')}
          aria-label={t('重置缩放（{zoom}）', { zoom: label })}
        >
          {label}
        </button>
      )}
    </>
  );
}
