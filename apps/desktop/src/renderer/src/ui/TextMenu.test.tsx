// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

describe('right click in a text box (the input box, a field in 设置)', () => {
  it('剪切 / 复制 / 粘贴 / 全选; the box gets its focus and selection back before the command runs', () => {
    const edit = vi.fn();
    const host = page('<textarea>下周一前把报价单发给供应商</textarea><button id="away">x</button>');
    render(<TextMenu edit={edit} />);
    const box = host.querySelector('textarea')!;
    box.focus();
    box.setSelectionRange(5, 8);
    rightClick(box);
    expect(labels()).toEqual(['剪切', '复制', '粘贴', '全选']);
    (host.querySelector('#away') as HTMLElement).focus();
    box.setSelectionRange(0, 0);
    fireEvent.click(screen.getByRole('menuitem', { name: '剪切' }));
    expect(document.activeElement).toBe(box);
    expect([box.selectionStart, box.selectionEnd]).toEqual([5, 8]);
    expect(edit).toHaveBeenLastCalledWith('cut');
    rightClick(box);
    fireEvent.click(screen.getByRole('menuitem', { name: '粘贴' }));
    expect(edit).toHaveBeenLastCalledWith('paste');
  });

  it('greyed: 剪切 and 复制 with nothing selected, 全选 in an empty box, 剪切 and 粘贴 in a read-only one, 剪切 and 复制 in a password', () => {
    const host = page('<textarea id="t">报价单</textarea><input id="e" value=""><input id="r" readonly value="C:\\Users\\me"><input id="p" type="password" value="abc">');
    render(<TextMenu edit={vi.fn()} />);
    const t = host.querySelector<HTMLTextAreaElement>('#t')!;
    t.setSelectionRange(2, 2);
    rightClick(t);
    expect(labels()).toEqual(['剪切（灰）', '复制（灰）', '粘贴', '全选']);
    rightClick(host.querySelector('#e')!);
    expect(labels()).toEqual(['剪切（灰）', '复制（灰）', '粘贴', '全选（灰）']);
    const r = host.querySelector<HTMLInputElement>('#r')!;
    r.setSelectionRange(0, 3);
    rightClick(r);
    expect(labels()).toEqual(['剪切（灰）', '复制', '粘贴（灰）', '全选']);
    const p = host.querySelector<HTMLInputElement>('#p')!;
    p.setSelectionRange(0, 3);
    rightClick(p);
    expect(labels()).toEqual(['剪切（灰）', '复制（灰）', '粘贴', '全选']);
  });

  it('a number box (同时请求, 每分钟请求) tells no selection: 剪切 and 复制 while it has words, and the command still runs', () => {
    const edit = vi.fn();
    const host = page('<input id="n" type="number" value="30"><input id="z" type="number" value="">');
    render(<TextMenu edit={edit} />);
    const n = host.querySelector<HTMLInputElement>('#n')!;
    expect(n.selectionStart).toBeNull();
    rightClick(n);
    expect(labels()).toEqual(['剪切', '复制', '粘贴', '全选']);
    fireEvent.click(screen.getByRole('menuitem', { name: '复制' }));
    expect(edit).toHaveBeenLastCalledWith('copy');
    expect(document.activeElement).toBe(n);
    rightClick(host.querySelector('#z')!);
    expect(labels()).toEqual(['剪切（灰）', '复制（灰）', '粘贴', '全选（灰）']);
  });

  it('the menu’s keys: Down skips the greyed items, Esc closes it and nothing runs', () => {
    const edit = vi.fn();
    const host = page('<textarea>报价单</textarea>');
    render(<TextMenu edit={edit} />);
    const box = host.querySelector('textarea')!;
    box.setSelectionRange(1, 1);
    rightClick(box);
    const menu = screen.getByRole('menu');
    act(() => menu.focus());
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('粘贴');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('全选');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(edit).not.toHaveBeenCalled();
  });
});
