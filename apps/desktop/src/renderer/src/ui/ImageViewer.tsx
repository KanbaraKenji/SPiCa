// A picture at full size over the window; Esc or a click closes it, and the keyboard stays with it while it is
// open (useModal). Ctrl+wheel zooms it around the pointer (not the window); dragging moves it. With other
// pictures of its group (one message, one answer, the input box's), ‹ N of M › under it and the arrow keys go
// to the one before or after (他: 「看图片也给我加上这个可以放大以后直接切换下一张」).
import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Icon } from './Icon';
import { useModal } from './useModal';

export interface Picture {
  url: string;
  name: string;
}

interface GroupEntry extends Picture {
  el: HTMLElement;
}

const ImageGroupContext = createContext<Set<GroupEntry> | null>(null);

/** The pictures inside are one group: opened full size, the viewer goes through them in the order they show. */
export function ImageGroup({ children }: { children: ReactNode }) {
  const [entries] = useState(() => new Set<GroupEntry>());
  return <ImageGroupContext.Provider value={entries}>{children}</ImageGroupContext.Provider>;
}

/**
 * A picture of a group (its element, once its URL is known). Returns what the viewer needs when it is opened:
 * the group's pictures in the order they show, and which one this is; alone (no group around it) just itself.
 */
export function useImageGroup(ref: RefObject<HTMLElement | null>, url: string | null, name: string): () => { pictures: Picture[]; index: number } {
  const entries = useContext(ImageGroupContext);
  useEffect(() => {
    const el = ref.current;
    if (!entries || !el || !url) return;
    const entry = { el, url, name };
    entries.add(entry);
    return () => {
      entries.delete(entry);
    };
  }, [entries, ref, url, name]);
  return () => {
    const el = ref.current;
    const all = entries ? [...entries].filter((e) => e.el.isConnected).sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)) : [];
    const index = all.findIndex((e) => e.el === el);
    if (index < 0) return { pictures: url ? [{ url, name }] : [], index: 0 };
    return { pictures: all.map((e) => ({ url: e.url, name: e.name })), index };
  };
}

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

/**
 * `pictures` and `start`: the group and the one opened first. Going past the first or the last stops there (the
 * button for that side is off), so N of M always says where one is.
 */
export function ImageViewer({ pictures, start = 0, onClose }: { pictures: Picture[]; start?: number; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(Math.min(Math.max(0, start), Math.max(0, pictures.length - 1)));
  const [view, setView] = useState<ImageView>({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  // The keyboard starts on the viewer itself, not on its first button.
  useModal(box, onClose, box);
  const count = pictures.length;
  const go = (step: number) => {
    const next = at + step;
    if (next < 0 || next >= count) return;
    setAt(next);
    setView({ scale: 1, x: 0, y: 0 });
  };
  const shown = pictures[at];
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
      role="dialog"
      aria-modal="true"
      aria-label={shown?.name}
      tabIndex={-1}
      ref={box}
      className={count > 1 ? 'image-viewer has-nav' : 'image-viewer'}
      onKeyDown={(e) => {
        if (count < 2 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        e.stopPropagation();
        go(e.key === 'ArrowLeft' ? -1 : 1);
      }}
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
      {shown ? (
        <img
          src={shown.url}
          alt={shown.name}
          draggable={false}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          className={view.scale !== 1 ? 'is-zoomed' : undefined}
        />
      ) : null}
      {count > 1 ? (
        // A click here moves between pictures; it does not close the viewer or start a drag.
        <div className="image-viewer-nav" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" className="icon-btn" aria-label="上一张" title="上一张" disabled={at === 0} onClick={() => go(-1)}>
            <Icon name="chevronLeft" size={16} />
          </button>
          <span className="image-viewer-count" aria-live="polite">
            {at + 1} of {count}
          </span>
          <button type="button" className="icon-btn" aria-label="下一张" title="下一张" disabled={at === count - 1} onClick={() => go(1)}>
            <Icon name="chevronRight" size={16} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
