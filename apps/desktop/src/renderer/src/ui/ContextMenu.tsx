// A small right-click menu at the pointer. Closes on Esc, a click elsewhere,
// scrolling or resizing. Positions in CSS px, so page zoom keeps it in place.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
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
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className="context-item"
          onClick={() => {
            onClose();
            it.onSelect();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
