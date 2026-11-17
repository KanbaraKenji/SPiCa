// A page's own zoom (Ctrl + wheel, Ctrl + plus / minus / 0 in the page; main/browser/page-zoom.ts), as Chrome
// shows it: a lens at the end of the address box (or of a run HTML file's row gap) whenever the page is not at
// 100%, with a plus when bigger, a minus when smaller; nothing at 100%. Just after a change a small layer under it
// shows − the zoom +: − and + one step (the Ctrl + minus / plus steps, grey at either end), the number pressed back
// to 100%. It goes ZOOM_MARK_MS after the last change (Chrome's own delay) unless the pointer is on it; pressing
// − or + in it is a change too, so it stays where it is. The lens pressed opens the layer again, and it stays until
// a press elsewhere, a press in the page or Escape (as Chrome's, opened by hand). The lens sits in room kept for it
// (styles.css .zoom-mark), so nothing moves when it comes or goes. A screen reader hears the new zoom once; nothing
// is left for it after.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DesktopBridge } from '../../../shared/bridge';
import { DEFAULT_ZOOM, ZOOM_STEPS, zoomLabel } from '../../../shared/zoom';
import { t } from '../../../shared/i18n';
import { Icon } from '../ui/Icon';
import { useEscape } from '../ui/escape';

export type PageZoomBridge = Pick<DesktopBridge['browser'], 'zoom' | 'onZoom'>;

/** How long the layer stays after the last change (ms): Chrome's zoom bubble's. */
export const ZOOM_MARK_MS = 1500;

const atDefault = (v: number) => Math.abs(v - DEFAULT_ZOOM) < 0.001;

export function ZoomMark({ zoom: bridge, wcId }: { zoom: PageZoomBridge; wcId: number | null }) {
  // The page's zoom as drawn, for the page it was read for.
  const [zoom, setZoom] = useState<{ wcId: number; value: number } | null>(null);
  // The layer: 'auto' after a change (goes by itself), 'hand' opened from the lens (stays); null: closed.
  const [open, setOpen] = useState<'auto' | 'hand' | null>(null);
  // Said to a screen reader once, after a change; emptied when the layer goes.
  const [said, setSaid] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const over = useRef(false);
  const lens = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const close = () => {
    stop();
    setOpen(null);
    setSaid('');
  };
  const later = () => {
    stop();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!over.current) close();
    }, ZOOM_MARK_MS);
  };
  useEffect(() => {
    if (wcId === null) return undefined;
    let live = true;
    void bridge.zoom(wcId, 'get').then((value) => live && setZoom((z) => (z?.wcId === wcId ? z : { wcId, value })));
    const off = bridge.onZoom((z) => {
      if (z.wcId !== wcId) return;
      setZoom({ wcId, value: z.zoom });
      if (!z.stepped) return;
      setSaid(t('缩放 {zoom}', { zoom: zoomLabel(z.zoom) }));
      // A change with the layer opened by hand keeps it open (and its number new); otherwise it goes by itself.
      setOpen((o) => {
        if (o !== 'hand') later();
        return o ?? 'auto';
      });
    });
    return () => {
      live = false;
      off();
      stop();
      over.current = false;
      setOpen(null);
      setSaid('');
      setZoom(null);
    };
    // later / stop only touch the refs and the state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, wcId]);

  const value = zoom && zoom.wcId === wcId ? zoom.value : DEFAULT_ZOOM;
  const label = zoomLabel(value);
  // The lens: whenever the page is not at 100%, and while the layer shows (Ctrl + 0 shows 100% a moment).
  const showLens = wcId !== null && (!atDefault(value) || open !== null);

  // Escape: closed; back to the lens only when it was opened from there (not out of the address box after a zoom).
  useEscape(open !== null, () => {
    const byHand = open === 'hand';
    close();
    if (byHand) lens.current?.focus();
  });

  // Under the lens, its right edge at the lens's, inside the window.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const a = lens.current?.getBoundingClientRect();
    const r = layer.current?.getBoundingClientRect();
    if (a && r) setPos({ left: Math.max(4, Math.min(a.right - r.width, window.innerWidth - r.width - 4)), top: a.bottom + 4 });
  }, [open, label]);

  // A press in the page itself reaches this window only as its losing the focus (no pointerdown, no focusin):
  // opened by hand, that closes it; just after a change, it goes the usual time after (the pointer is not on it).
  useEffect(() => {
    if (!open) return undefined;
    const blur = () => {
      if (open === 'hand') close();
      else {
        over.current = false;
        later();
      }
    };
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
    // close / later only touch the refs and the state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Opened by hand: the number (back to 100%) has the focus. A press or the focus elsewhere in the window, the window resized: gone.
  useEffect(() => {
    if (open !== 'hand') return undefined;
    layer.current?.querySelector<HTMLButtonElement>('[data-zoom-reset]')?.focus();
    const outside = (e: Event) => {
      const n = e.target as Node;
      if (!layer.current?.contains(n) && !lens.current?.contains(n)) close();
    };
    window.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', close);
    };
    // close only touches the refs and the state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <span className="visually-hidden" aria-live="polite">
        {said}
      </span>
      {showLens ? (
        <button
          ref={lens}
          type="button"
          className="icon-btn zoom-mark"
          aria-label={t('缩放 {zoom}', { zoom: label })}
          title={t('缩放 {zoom}', { zoom: label })}
          aria-haspopup="dialog"
          aria-expanded={open !== null}
          onClick={() => {
            stop();
            over.current = false;
            setOpen((o) => (o === 'hand' ? null : 'hand'));
          }}
        >
          <Icon name={value < DEFAULT_ZOOM ? 'zoomOut' : 'zoomIn'} size={15} />
        </button>
      ) : null}
      {open && wcId !== null
        ? createPortal(
            <div
              ref={layer}
              className="context-menu zoom-layer"
              role="dialog"
              aria-label={t('缩放')}
              style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
              onPointerEnter={() => {
                over.current = true;
                stop();
              }}
              onPointerLeave={() => {
                over.current = false;
                if (open === 'auto') later();
              }}
            >
              <button
                type="button"
                className="icon-btn"
                disabled={value <= Math.min(...ZOOM_STEPS)}
                onClick={() => void bridge.zoom(wcId, 'out')}
                aria-label={t('缩小')}
                title={t('缩小')}
              >
                <Icon name="minus" size={15} />
              </button>
              <button
                type="button"
                className="zoom-layer-value num"
                data-zoom-reset
                onClick={() => void bridge.zoom(wcId, 'reset')}
                aria-label={t('{zoom}，回到 100%', { zoom: label })}
                title={t('回到 100%')}
              >
                {label}
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={value >= Math.max(...ZOOM_STEPS)}
                onClick={() => void bridge.zoom(wcId, 'in')}
                aria-label={t('放大')}
                title={t('放大')}
              >
                <Icon name="plus" size={15} />
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
