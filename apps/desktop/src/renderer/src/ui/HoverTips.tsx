// The one hover note of the app: an element's name or note (its `title`, or
// `data-tip`) shows in a small bubble above it, the same everywhere, instead of
// Windows' own tooltip. Mounted once at the root; nothing else needs to change
// for a button to get it. While the bubble is up the element's `title` is held
// back (so Windows does not show its own as well) and put back on leaving, so
// the DOM reads as before. Also on keyboard focus (focus-visible).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const DELAY_MS = 250;
const GAP = 6;
const EDGE = 8;

interface Tip {
  text: string;
  rect: DOMRect;
}

const tipOf = (el: HTMLElement) => el.getAttribute('data-tip') ?? el.dataset.heldTitle ?? el.getAttribute('title') ?? '';

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
      hold(el);
      timer = setTimeout(() => {
        if (current === el && el.isConnected) setTip({ text: tipOf(el), rect: el.getBoundingClientRect() });
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
      document.removeEventListener('keydown', hide, true);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // Above the element, centred, kept inside the window; below it when there is no room above.
  useLayoutEffect(() => {
    const b = bubble.current;
    if (!tip || !b) {
      setPos(null);
      return;
    }
    const w = b.offsetWidth;
    const h = b.offsetHeight;
    const r = tip.rect;
    const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - w / 2), window.innerWidth - w - EDGE);
    const top = r.top - GAP - h >= EDGE ? r.top - GAP - h : r.bottom + GAP;
    setPos({ left, top });
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={bubble} className="hover-tip" role="tooltip" style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}>
      {tip.text}
    </div>
  );
}
