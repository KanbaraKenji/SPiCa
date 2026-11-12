// The small dialog window's page (main/app-dialog-window.ts): title, lines, optional radio choices, an optional
// checkbox, buttons and an optional × at the top right, from the spec in the query. Built like the page's dialogs
// (ui/Dialog.tsx, ui/CloseDialog.tsx): the main button last and focused, Enter clicks the focused button (the main one
// unless Tab moved on; on a choice or the checkbox it is the main one). No Esc. The × and closing the window answer
// nothing. The × comes last in the markup, so Tab reaches it after the buttons (as in CloseDialog).
import './dialog.css';
import { parseDialogSpec } from '../../shared/app-dialog';

interface Bridge {
  ready(height: number): void;
  answer(button: number, checked: boolean, choice: number | null): void;
}
const bridge = (window as unknown as { spicaDialog?: Bridge }).spicaDialog;
const spec = parseDialogSpec(new URLSearchParams(location.search).get('spec'));

if (bridge && spec) {
  const root = document.documentElement;
  root.dataset.scheme = spec.scheme;
  root.style.colorScheme = spec.scheme;
  for (const [name, value] of Object.entries(spec.tokens)) if (value) root.style.setProperty(name, value);
  if (spec.font) root.style.setProperty('--font-ui', spec.font);
  document.title = spec.title;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const e = document.createElement(tag);
    e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const box = el('div', spec.closeButton ? 'dialog has-x' : 'dialog');
  box.setAttribute('role', 'alertdialog');
  const title = el('p', 'dialog-title', spec.title);
  title.id = 'dialog-title';
  box.setAttribute('aria-labelledby', title.id);
  box.append(title, ...spec.detail.map((line) => el('p', 'dialog-detail', line)));

  let choice: number | null = null;
  if (spec.choices) {
    const group = el('div', 'dialog-choices');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-labelledby', title.id);
    choice = spec.choices.selected;
    spec.choices.options.forEach((label, i) => {
      const row = el('label', 'dialog-check');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'choice';
      radio.checked = i === choice;
      radio.addEventListener('change', () => {
        if (radio.checked) choice = i;
      });
      row.append(radio, label);
      group.append(row);
    });
    box.append(group);
  }

  let check: HTMLInputElement | null = null;
  let checkRow: HTMLLabelElement | null = null;
  if (spec.check) {
    checkRow = el('label', 'dialog-check');
    check = document.createElement('input');
    check.type = 'checkbox';
    checkRow.append(check, spec.check);
  }

  let done = false;
  const answer = (button: number) => {
    if (done) return;
    done = true;
    bridge.answer(button, check?.checked ?? false, choice);
  };
  const actions = el('div', 'dialog-actions');
  let primary: HTMLButtonElement | null = null;
  spec.buttons.forEach((b, i) => {
    const button = el('button', b.primary ? 'btn btn-primary' : 'btn', b.label);
    button.type = 'button';
    button.addEventListener('click', () => answer(i));
    if (b.primary) primary = button;
    actions.append(button);
  });

  if (checkRow && spec.checkInFoot) {
    const foot = el('div', 'dialog-foot');
    foot.append(checkRow, actions);
    box.append(foot);
  } else {
    if (checkRow) box.append(checkRow);
    box.append(actions);
  }

  if (spec.closeButton) {
    const x = el('button', 'icon-btn dialog-x');
    x.type = 'button';
    x.setAttribute('aria-label', '关闭');
    x.title = '关闭';
    // ui/Icon.tsx: the close icon, 16 px, stroke 1.4.
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    for (const [k, v] of Object.entries({ width: '16', height: '16', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M4 4l8 8 M12 4l-8 8');
    svg.append(path);
    x.append(svg);
    x.addEventListener('click', () => answer(-1));
    box.append(x);
  }
  document.body.append(box);

  // Enter on a choice, the checkbox (or nowhere) is the main button; on a button it is that button (the browser's own).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    primary?.click();
  });
  (primary as HTMLButtonElement | null)?.focus();
  requestAnimationFrame(() => bridge.ready(Math.ceil(box.getBoundingClientRect().height)));
}
