// Right click on words selected anywhere in the page that is not a text box (an answer, your message, a step's
// output, a code block): 复制. The window's own copy does the work (bridge.edit, main runs webContents.copy), so it is
// the same as Ctrl+C: the copy handlers of the page run (an answer's full paths). In a text box (the input box, a
// field in 设置) the right click is left to main, which shows Windows' own menu (main/edit-menu.ts). Elsewhere (no
// selection, a row with a menu of its own) nothing is added.
import { useEffect, useState } from 'react';
import { ContextMenu, type MenuItem } from './ContextMenu';

export type EditCommand = 'cut' | 'copy' | 'paste' | 'selectAll';

/** A text box, where Windows' own menu is shown instead (main/edit-menu.ts). */
function inField(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('textarea, input, [contenteditable=""], [contenteditable="true"]') !== null;
}

interface Open {
  /** A new menu each right click (a second one while one is open starts afresh where the pointer is). */
  n: number;
  x: number;
  y: number;
  items: MenuItem[];
}

/** What the right click found: 复制 for words selected outside a text box, and how to put them back (the menu took the focus). */
function menuFor(e: MouseEvent, edit: (c: EditCommand) => void): MenuItem[] | null {
  if (inField(e.target)) return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) return null;
  const ranges = Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i).cloneRange());
  return [
    {
      label: '复制',
      onSelect: () => {
        const now = window.getSelection();
        now?.removeAllRanges();
        for (const r of ranges) now?.addRange(r);
        edit('copy');
      },
    },
  ];
}

/** Mounted once beside the app. `edit`: the window's editing command (bridge.edit). */
export function TextMenu({ edit }: { edit: (c: EditCommand) => void }) {
  const [open, setOpen] = useState<Open | null>(null);
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      // A row, the title or anything else with a menu of its own has had it already.
      if (e.defaultPrevented) return;
      const items = menuFor(e, edit);
      if (!items) return;
      e.preventDefault();
      setOpen((o) => ({ n: (o?.n ?? 0) + 1, x: e.clientX, y: e.clientY, items }));
    };
    document.addEventListener('contextmenu', onMenu);
    return () => document.removeEventListener('contextmenu', onMenu);
  }, [edit]);
  if (!open) return null;
  return (
    // Over dialogs too (a field in 设置): the menu's own layer is under theirs.
    <div className="text-menu-layer">
      <ContextMenu key={open.n} x={open.x} y={open.y} items={open.items} onClose={() => setOpen(null)} />
    </div>
  );
}
