// A small right-click menu at the pointer, or under a button that opens it (`anchor`).
// Closes on Esc, a click elsewhere, scrolling or resizing. Positions in CSS px, so
// page zoom keeps it in place.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface MenuItem {
  label: string;
  /** Deletes something: shown in the danger color. */
  danger?: boolean;
  /** A heading shown above the first item of each run with the same group. */
  group?: string;
  /** What tells two groups apart when their headings read the same (two connections with one name); absent: the heading itself. */
  groupKey?: string;
  /** A short tag at the right end of the item. */
  hint?: string;
  /** One line under the label saying what it does. */
  detail?: string;
  /** Shown but cannot be picked; `title` says why on hover (not the disabled attribute: it would not show one). */
  disabled?: boolean;
  /** Said on hover. */
  title?: string;
  /**
   * One of a set of choices: true on the one in force (a tick at the end of its row), false on the others.
   * Nothing is kept in front of the labels for it, so the menu is no wider than its words.
   */
  checked?: boolean;
  /** Right after the label (a mark such as 支持图片). */
  after?: ReactNode;
  onSelect(): void;
}

const groupOf = (it: MenuItem | undefined) => it?.groupKey ?? it?.group;

/**
 * `anchor`: the button that opened the menu. The menu sits under it (above it when there is no
 * room below), and pressing that button again is left to the button, so a second click closes.
 * `side: 'above'`: over the button first (the row under the message box), under it only when
 * there is no room above. Either way 4px from the button, measured from the menu as drawn.
 */
export function ContextMenu({ x, y, items, onClose, anchor, side = 'below' }: { x: number; y: number; items: MenuItem[]; onClose(): void; anchor?: HTMLElement | null; side?: 'above' | 'below' }) {
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
      const below = a.bottom + 4;
      const above = a.top - 4 - r.height;
      const fitsBelow = below + r.height <= window.innerHeight - 4;
      const fitsAbove = above >= 4;
      top = side === 'above' ? (fitsAbove || !fitsBelow ? above : below) : fitsBelow ? below : above;
    }
    setPos({ left: Math.max(4, Math.min(left, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(top, window.innerHeight - r.height - 4)) });
    el.querySelector<HTMLButtonElement>('button:not([aria-disabled="true"])')?.focus();
  }, [x, y, anchor, side]);

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
    // One item lit at a time: the first takes the keyboard focus on opening; once the pointer moves onto
    // another, the focus goes to the menu itself, so only the item under the pointer is lit.
    <div ref={ref} className="context-menu" role="menu" tabIndex={-1} style={{ left: pos.left, top: pos.top }}>
      {items.map((it, i) => (
        <div key={`${groupOf(it) ?? ''}	${it.label}	${i}`} role="none">
          {it.group && groupOf(it) !== groupOf(items[i - 1]) ? (
            <div className="context-group" role="presentation">
              {it.group}
            </div>
          ) : null}
          <button
            type="button"
            role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={it.checked}
            className={it.danger ? 'context-item is-danger' : 'context-item'}
            aria-disabled={it.disabled || undefined}
            // Its own note (why it cannot be picked), else the label when it is cut short.
            {...(it.title ? { title: it.title } : { title: it.label, 'data-tip-clipped': '.context-item-label' })}
            onPointerMove={(e) => {
              const focused = document.activeElement;
              if (focused !== e.currentTarget && focused instanceof HTMLElement && ref.current?.contains(focused)) ref.current.focus({ preventScroll: true });
            }}
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
            {it.checked ? (
              <span className="context-item-check" aria-hidden>
                <Icon name="check" size={14} />
              </span>
            ) : null}
          </button>
        </div>
      ))}
    </div>
  );
}
