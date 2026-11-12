// What every modal does with the keyboard: focus starts inside (on `initial`,
// else the first control), Tab and Shift+Tab go round inside it and never to
// the page behind, Esc closes it, and on closing the focus goes back to what
// opened it. Esc is one layer of ui/escape.ts: a confirm box, a menu or a field opened inside closes first.
import { useEffect, type RefObject } from 'react';
import { useEscape } from './escape';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModal(box: RefObject<HTMLElement | null>, onClose: () => void, initial?: RefObject<HTMLElement | null>): void {
  // Before the focus moves inside (the layer notes the button that opened it).
  useEscape(true, onClose);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = box.current;
    if (!el) return;
    const inside = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
    (initial?.current ?? inside()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const all = inside();
      if (!all.length) {
        e.preventDefault();
        return;
      }
      const first = all[0]!;
      const last = all[all.length - 1]!;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !el.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !el.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [box, initial]);
}
