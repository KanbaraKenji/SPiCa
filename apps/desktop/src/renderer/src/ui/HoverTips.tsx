// The one hover note of the app: an element's name or note (its `title`, or
// `data-tip`) shows in a small bubble above it, the same everywhere, instead of
// Windows' own tooltip. Mounted once at the root; nothing else needs to change
// for a button to get it. While the bubble is up the element's `title` is held
// back (so Windows does not show its own as well) and put back on leaving, so
// the DOM reads as before. Also on keyboard focus (focus-visible).
// An element whose note only repeats its own text (a name that may be cut short)
// carries `data-tip-clipped`: the bubble shows only while that text is cut off
// with an ellipsis. Its value is the selector of the child holding the text
// ('' = the element itself).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const DELAY_MS = 250;
const GAP = 6;
const EDGE = 8;

interface Tip {
  text: string;
  rect: DOMRect;
  /** A menu item's note: the menu's box, so the bubble goes beside the menu instead of over the item above. */
  menu?: DOMRect;
}

/**
 * Where the bubble goes. A menu item's: outside the menu, level with the item, on the right; on the left when
 * the right has no room; above only when neither has. Anything else: above the element, centred, kept inside
 * the window; below it when there is no room above.
 */
export function placeTip(t: Tip, w: number, h: number, win: { width: number; height: number }): { left: number; top: number } {
  const r = t.rect;
  if (t.menu) {
    const top = Math.min(Math.max(EDGE, r.top + r.height / 2 - h / 2), win.height - h - EDGE);
    if (t.menu.right + GAP + w <= win.width - EDGE) return { left: t.menu.right + GAP, top };
    if (t.menu.left - GAP - w >= EDGE) return { left: t.menu.left - GAP - w, top };
  }
  const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - w / 2), win.width - w - EDGE);
  return { left, top: r.top - GAP - h >= EDGE ? r.top - GAP - h : r.bottom + GAP };
}

const tipOf = (el: HTMLElement) => el.getAttribute('data-tip') ?? el.dataset.heldTitle ?? el.getAttribute('title') ?? '';

/** For `data-tip-clipped`: whether the text is cut short now (wider than its box). Without the mark: always shown. */
export function tipWanted(el: HTMLElement): boolean {
  const sel = el.getAttribute('data-tip-clipped');
  if (sel === null) return true;
  const box = (sel ? el.querySelector<HTMLElement>(sel) : null) ?? el;
  // Not shown at all (a narrow window shows an icon instead): the note is the only way to read it.
  if (box.getClientRects().length === 0) return true;
  return box.scrollWidth > box.clientWidth + 1;
}

export function HoverTips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hold = (el: HTMLElement) => {
      const t = el.getAttribute('title');
      if (t !== null) {
        el.dataset.heldTitle = t;
        el.removeAttribute('title');
      }
    };
    const release = (el: HTMLElement) => {
      if (el.dataset.heldTitle !== undefined) {
        el.setAttribute('title', el.dataset.heldTitle);
        delete el.dataset.heldTitle;
      }
    };
    const hide = () => {
      clearTimeout(timer);
      if (current) release(current);
      current = null;
      setTip(null);
    };
    const target = (node: EventTarget | null) => (node instanceof Element ? (node.closest('[title], [data-tip], [data-held-title]') as HTMLElement | null) : null);
    const start = (el: HTMLElement | null, wait: number) => {
      if (el === current) return;
      hide();
      if (!el || !tipOf(el)) return;
      // iframes name themselves with title for screen readers; that is not a note.
      if (el.tagName === 'IFRAME') return;
      current = el;
      // Held either way, so Windows does not show its own note for a name shown in full.
      hold(el);
      if (!tipWanted(el)) return;
      timer = setTimeout(() => {
        if (current !== el || !el.isConnected) return;
        const menu = el.getAttribute('role') === 'menuitem' ? el.closest('[role="menu"]') : null;
        setTip({ text: tipOf(el), rect: el.getBoundingClientRect(), ...(menu ? { menu: menu.getBoundingClientRect() } : {}) });
      }, wait);
    };
    const over = (e: PointerEvent) => start(target(e.target), DELAY_MS);
    const out = (e: PointerEvent) => {
      if (!e.relatedTarget) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = target(e.target);
      if (el && el === e.target && el.matches(':focus-visible')) start(el, 0);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('click', hide, true);
    document.addEventListener('keydown', hide, true);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('click', hide, true);
      document.removeEventListener('keydown', hide, true);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);

  useLayoutEffect(() => {
    const b = bubble.current;
    if (!tip || !b) {
      setPos(null);
      return;
    }
    setPos(placeTip(tip, b.offsetWidth, b.offsetHeight, { width: window.innerWidth, height: window.innerHeight }));
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={bubble} className="hover-tip" role="tooltip" style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}>
      {tip.text}
    </div>
  );
}
