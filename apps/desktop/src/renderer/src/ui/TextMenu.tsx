// Right click on words: in a field (the input box, any text box) 剪切 / 复制 / 粘贴 / 全选; on words selected
// anywhere else (an answer, your message, a step's output, a code block) 复制. The window's own editing commands
// do the work (bridge.edit, main runs webContents.cut / copy / paste / selectAll), so it is the same as Ctrl+X /
// C / V / A: the copy handlers of the page run (an answer's full paths), a picture pastes into the input box, and
// Ctrl+Z undoes it. Elsewhere (no selection, a row with a menu of its own) nothing is added.
import { useEffect, useState } from 'react';
import { ContextMenu, type MenuItem } from './ContextMenu';

export type EditCommand = 'cut' | 'copy' | 'paste' | 'selectAll';

type Field = HTMLTextAreaElement | HTMLInputElement;

/** Input types that hold words one can select (not a checkbox, a colour, a range…). */
const TEXT_INPUTS = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', '']);

function fieldOf(target: EventTarget | null): Field | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest('textarea, input');
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type)) return el;
  return null;
}

interface Open {
  /** A new menu each right click (a second one while one is open starts afresh where the pointer is). */
  n: number;
  x: number;
  y: number;
  items: MenuItem[];
}

/** What the right click found, and how to put it back before the command runs (the menu took the focus). */
function menuFor(e: MouseEvent, edit: (c: EditCommand) => void): MenuItem[] | null {
  const field = fieldOf(e.target);
  if (field) {
    if (field.disabled) return null;
    // A number or email box tells no selection (null) and refuses to be given one: what is selected there is not
    // known, so 剪切 and 复制 stay on while it has words, and focusing it again brings its own selection back.
    const ranged = field.selectionStart !== null;
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? 0;
    const selected = field.type !== 'password' && (ranged ? end > start : field.value !== '');
    const run = (c: EditCommand) => () => {
      field.focus({ preventScroll: true });
      if (ranged) field.setSelectionRange(start, end);
      edit(c);
    };
    return [
      { label: '剪切', disabled: !selected || field.readOnly, onSelect: run('cut') },
      { label: '复制', disabled: !selected, onSelect: run('copy') },
      { label: '粘贴', disabled: field.readOnly, onSelect: run('paste') },
      { label: '全选', disabled: field.value === '', onSelect: run('selectAll') },
    ];
  }
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
