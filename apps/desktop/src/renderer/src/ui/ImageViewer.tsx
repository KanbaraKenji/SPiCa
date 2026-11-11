// A picture at full size over the window; Esc or a click closes it, and the keyboard stays with it while it is
// open (useModal). Ctrl+wheel zooms it around the pointer (not the window); dragging moves it.
import { useEffect, useRef, useState } from 'react';
import { useModal } from './useModal';

export interface ImageView {
  scale: number;
  /** How far the picture is moved from the middle, in pixels. */
  x: number;
  y: number;
}

export const IMAGE_SCALE = { min: 0.25, max: 8 };

/**
 * Zoomed by `factor` around a point given from the middle of the view (px, py): that point of the picture
 * stays under the pointer. The scale stays within IMAGE_SCALE; back at 1 the picture sits in the middle again.
 */
export function zoomView(v: ImageView, factor: number, px: number, py: number): ImageView {
  const scale = Math.min(IMAGE_SCALE.max, Math.max(IMAGE_SCALE.min, v.scale * factor));
  if (scale === v.scale) return v;
  if (Math.abs(scale - 1) < 0.001) return { scale: 1, x: 0, y: 0 };
  const k = scale / v.scale;
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

/** A drag shorter than this is a click (it closes the viewer). */
const CLICK_SLOP = 4;

export function ImageViewer({ url, name, onClose }: { url: string; name: string; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ImageView>({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  useModal(box, onClose);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      // The picture's zoom, not the window's (that listener is on the window, after this one).
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const px = e.clientX - (r.left + r.width / 2);
      const py = e.clientY - (r.top + r.height / 2);
      setView((v) => zoomView(v, e.deltaY < 0 ? 1.15 : 1 / 1.15, px, py));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  return (
    <div
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={name}
      tabIndex={-1}
      ref={box}
      onClick={() => {
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        onClose();
      }}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || !(e.buttons & 1)) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
        d.moved = true;
        setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
      }}
      onPointerUp={() => {
        dragged.current = Boolean(drag.current?.moved);
        drag.current = null;
      }}
    >
      <img
        src={url}
        alt={name}
        draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        className={view.scale !== 1 ? 'is-zoomed' : undefined}
      />
    </div>
  );
}
