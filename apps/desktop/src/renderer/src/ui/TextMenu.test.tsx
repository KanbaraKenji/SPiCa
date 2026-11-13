// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TextMenu } from './TextMenu';

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

const labels = () => screen.queryAllByRole('menuitem').map((b) => b.textContent + (b.getAttribute('aria-disabled') ? '（灰）' : ''));

function rightClick(target: Element) {
  return fireEvent.contextMenu(target, { clientX: 100, clientY: 80 });
}

function selectWords(el: Element) {
  const r = document.createRange();
  r.selectNodeContents(el);
  const s = window.getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
}

function page(html: string) {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe('right click on words selected in the conversation', () => {
  it('复制 only; it puts the selection back (the menu took the focus) and runs the window’s copy, as Ctrl+C', () => {
    const edit = vi.fn();
    const host = page('<div class="md"><p id="a">外壳尺寸 120×80×24 mm</p></div>');
    render(<TextMenu edit={edit} />);
    const p = host.querySelector('#a')!;
    selectWords(p);
    const ev = rightClick(p);
    expect(ev).toBe(false); // the default (nothing in Electron) is taken over
    expect(labels()).toEqual(['复制']);
    window.getSelection()!.removeAllRanges();
    fireEvent.click(screen.getByRole('menuitem', { name: '复制' }));
    expect(edit).toHaveBeenCalledWith('copy');
    expect(window.getSelection()!.toString()).toBe('外壳尺寸 120×80×24 mm');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('nothing on words that are not selected, and nothing where a row has a menu of its own', () => {
    const edit = vi.fn();
    const host = page('<p id="a">看看资料</p><div id="row">整理本周来信</div>');
    render(<TextMenu edit={edit} />);
    expect(rightClick(host.querySelector('#a')!)).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    const row = host.querySelector('#row')!;
    row.addEventListener('contextmenu', (e) => e.preventDefault());
    selectWords(row);
    rightClick(row);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('right click in a text box (the input box, a field in 设置, a number box)', () => {
  it('left to Windows’ own menu (main/edit-menu.ts): the app draws none and does not take the event, words selected or not', () => {
    const edit = vi.fn();
    const host = page('<p id="a">外壳尺寸</p><textarea>下周一前把报价单发给供应商</textarea><input id="n" type="number" value="30"><input id="s" type="search" value="字号">');
    render(<TextMenu edit={edit} />);
    selectWords(host.querySelector('#a')!);
    for (const box of host.querySelectorAll('textarea, input')) {
      if (box instanceof HTMLTextAreaElement) box.setSelectionRange(5, 8);
      expect(rightClick(box)).toBe(true);
      expect(screen.queryByRole('menu')).toBeNull();
    }
    expect(edit).not.toHaveBeenCalled();
  });
});
