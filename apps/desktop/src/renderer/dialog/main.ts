// The small dialog window's page (main/app-dialog-window.ts): title, lines, an optional checkbox and buttons, from the
// spec in the query. Built like the page's dialogs (ui/Dialog.tsx, ui/CloseDialog.tsx): the main button last and
// focused, Enter clicks the focused button (the main one unless Tab moved on). No Esc. Closing the window answers nothing.
import './dialog.css';
import { parseDialogSpec } from '../../shared/app-dialog';

interface Bridge {
  ready(height: number): void;
  answer(button: number, checked: boolean): void;
}
const bridge = (window as unknown as { spicaDialog?: Bridge }).spicaDialog;
const spec = parseDialogSpec(new URLSearchParams(location.search).get('spec'));

if (bridge && spec) {
  const root = document.documentElement;
  root.dataset.scheme = spec.scheme;
  root.style.colorScheme = spec.scheme;
  for (const [name, value] of Object.entries(spec.tokens)) if (value) root.style.setProperty(name, value);
  document.title = spec.title;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const e = document.createElement(tag);
    e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const box = el('div', 'dialog');
  box.setAttribute('role', 'alertdialog');
  const title = el('p', 'dialog-title', spec.title);
  title.id = 'dialog-title';
  box.setAttribute('aria-labelledby', title.id);
  box.append(title, ...spec.detail.map((line) => el('p', 'dialog-detail', line)));

  let check: HTMLInputElement | null = null;
  if (spec.check) {
    const label = el('label', 'dialog-check');
    check = document.createElement('input');
    check.type = 'checkbox';
    label.append(check, spec.check);
    box.append(label);
  }

  let done = false;
  const actions = el('div', 'dialog-actions');
  let primary: HTMLButtonElement | null = null;
  spec.buttons.forEach((b, i) => {
    const button = el('button', b.primary ? 'btn btn-primary' : 'btn', b.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      if (done) return;
      done = true;
      bridge.answer(i, check?.checked ?? false);
    });
    if (b.primary) primary = button;
    actions.append(button);
  });
  box.append(actions);
  document.body.append(box);

  // Enter on the checkbox (or nowhere) is the main button; on a button it is that button (the browser's own).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    primary?.click();
  });
  (primary as HTMLButtonElement | null)?.focus();
  requestAnimationFrame(() => bridge.ready(Math.ceil(box.getBoundingClientRect().height)));
}
