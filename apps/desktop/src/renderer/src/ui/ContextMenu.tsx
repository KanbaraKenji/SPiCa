// A small right-click menu at the pointer, or under a button that opens it (`anchor`).
// Closes on Esc, a click elsewhere, scrolling or resizing. Positions in CSS px, so
// page zoom keeps it in place.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  /** Deletes something: shown in the danger color. */
  danger?: boolean;
  /** A heading shown above the first item of each run with the same group. */
  group?: string;
  /** A short tag at the right end of the item. */
  hint?: string;
  /** One line under the label saying what it does. */
  detail?: string;
  /** Shown but cannot be picked; `title` says why on hover (not the disabled attribute: it would not show one). */
  disabled?: boolean;
  /** Said on hover. */
  title?: string;
  /** Right after the label (a mark such as 支持图片). */
  after?: ReactNode;
  onSelect(): void;
}

/**
 * `anchor`: the button that opened the menu. The menu sits under it (above it when there is no
 * room below), and pressing that button again is left to the button, so a second click closes.
 */
export function ContextMenu({ x, y, items, onClose, anchor }: { x: number; y: number; items: MenuItem[]; onClose(): void; anchor?: HTMLElement | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep it inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    // Measured here, once the button is shown (it may appear only with its menu open).
    if (anchor) {
      const a = anchor.getBoundingClientRect();
      left = a.left;
      top = a.bottom + 4 + r.height <= window.innerHeight - 4 ? a.bottom + 4 : a.top - 4 - r.height;
    }
    setPos({ left: Math.max(4, Math.min(left, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(top, window.innerHeight - r.height - 4)) });
    el.querySelector<HTMLButtonElement>('button:not([aria-disabled="true"])')?.focus();
  }, [x, y, anchor]);

  useEffect(() => {
    const close = () => onClose();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor?.contains(t)) onClose();
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
  }, [onClose, anchor]);

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
            aria-disabled={it.disabled || undefined}
            // Its own note (why it cannot be picked), else the label when it is cut short.
            {...(it.title ? { title: it.title } : { title: it.label, 'data-tip-clipped': '.context-item-label' })}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              it.onSelect();
            }}
          >
            {it.detail ? (
              <span className="context-item-text">
                <span className="context-item-label">
                  {it.label}
                  {it.after}
                </span>
                <span className="context-item-detail">{it.detail}</span>
              </span>
            ) : (
              <span className="context-item-label">
                {it.label}
                {it.after}
              </span>
            )}
            {it.hint ? <span className="context-item-hint">{it.hint}</span> : null}
          </button>
        </div>
      ))}
    </div>
  );
}
