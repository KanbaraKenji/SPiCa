// A small right-click menu at the pointer. Closes on Esc, a click elsewhere,
// scrolling or resizing. Positions in CSS px, so page zoom keeps it in place.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  /** Deletes something: shown in the danger color. */
  danger?: boolean;
  /** A heading shown above the first item of each run with the same group. */
  group?: string;
  /** A short tag at the right end of the item. */
  hint?: string;
  onSelect(): void;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep it inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
    el.querySelector<HTMLButtonElement>('button')?.focus();
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('wheel', close);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left: pos.left, top: pos.top }}>
      {items.map((it, i) => (
        <div key={`${it.group ?? ''}	${it.label}	${i}`} role="none">
          {it.group && it.group !== items[i - 1]?.group ? (
            <div className="context-group" role="presentation">
              {it.group}
            </div>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={it.danger ? 'context-item is-danger' : 'context-item'}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            <span className="context-item-label">{it.label}</span>
            {it.hint ? <span className="context-item-hint">{it.hint}</span> : null}
          </button>
        </div>
      ))}
    </div>
  );
}
