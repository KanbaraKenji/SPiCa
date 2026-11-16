// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ContextMenu } from './ContextMenu';

afterEach(cleanup);

function button(rect: { left: number; top: number; bottom: number }): HTMLElement {
  const b = document.createElement('button');
  document.body.appendChild(b);
  b.getBoundingClientRect = () => ({ ...rect, right: rect.left + 24, width: 24, height: rect.bottom - rect.top, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect;
  return b;
}

function menuSize(height: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('context-menu') ? ({ left: 0, top: 0, right: 140, bottom: height, width: 140, height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect) : ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  });
}

afterEach(() => vi.restoreAllMocks());

const items = [{ label: '重命名', onSelect: () => {} }];

describe('ContextMenu under a button', () => {
  it('sits under the button, at its left edge', () => {
    menuSize(80);
    const anchor = button({ left: 220, top: 100, bottom: 124 });
    render(<ContextMenu x={0} y={0} items={items} anchor={anchor} onClose={() => {}} />);
    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe('220px');
    expect(menu.style.top).toBe('128px');
  });

  it('goes above the button when there is no room below', () => {
    menuSize(80);
    const anchor = button({ left: 220, top: window.innerHeight - 40, bottom: window.innerHeight - 16 });
    render(<ContextMenu x={0} y={0} items={items} anchor={anchor} onClose={() => {}} />);
    expect(screen.getByRole('menu').style.top).toBe(`${window.innerHeight - 40 - 4 - 80}px`);
  });

  it('a press on its button is left to the button; a press elsewhere closes', () => {
    const onClose = vi.fn();
    const anchor = button({ left: 0, top: 0, bottom: 24 });
    render(<ContextMenu x={0} y={0} items={items} anchor={anchor} onClose={onClose} />);
    fireEvent.pointerDown(anchor);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('side above: 4px over the button whatever the menu holds; under it only when there is no room above', () => {
    for (const height of [108, 144, 172]) {
      menuSize(height);
      const anchor = button({ left: 300, top: 700, bottom: 728 });
      render(<ContextMenu x={0} y={0} items={items} anchor={anchor} side="above" onClose={() => {}} />);
      expect(screen.getByRole('menu').style.top).toBe(`${700 - 4 - height}px`);
      expect(screen.getByRole('menu').style.left).toBe('300px');
      cleanup();
      vi.restoreAllMocks();
    }
    menuSize(144);
    const anchor = button({ left: 300, top: 60, bottom: 88 });
    render(<ContextMenu x={0} y={0} items={items} anchor={anchor} side="above" onClose={() => {}} />);
    expect(screen.getByRole('menu').style.top).toBe('92px');
  });
});

describe('one item lit at a time', () => {
  it('the first item has the focus on opening; moving the pointer onto another takes it away, so only that one is lit', () => {
    const two = [
      { label: '重命名', onSelect: () => {} },
      { label: '删除', danger: true, onSelect: () => {} },
    ];
    render(<ContextMenu x={10} y={10} items={two} onClose={() => {}} />);
    const [first, second] = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(first);
    fireEvent.pointerMove(second!);
    expect(document.activeElement).toBe(screen.getByRole('menu'));
    // Moving within the same item again changes nothing; the menu stays open and usable.
    fireEvent.pointerMove(second!);
    expect(document.activeElement).toBe(screen.getByRole('menu'));
  });
});

describe('group headings', () => {
  it('two groups whose headings read the same are still two groups when their keys differ; no key: told by the heading', () => {
    const item = (label: string, group: string, groupKey?: string) => ({ label, group, ...(groupKey ? { groupKey } : {}), onSelect: () => {} });
    render(<ContextMenu x={0} y={0} items={[item('a', '同名', 'one'), item('b', '同名', 'one'), item('c', '同名', 'two')]} onClose={() => {}} />);
    expect(screen.getAllByText('同名')).toHaveLength(2);
    cleanup();
    render(<ContextMenu x={0} y={0} items={[item('a', '同名'), item('b', '同名'), item('c', '另一个')]} onClose={() => {}} />);
    expect(screen.getAllByText('同名')).toHaveLength(1);
    expect(screen.getAllByText('另一个')).toHaveLength(1);
  });
});

describe('a menu of choices', () => {
  it('the one in force has a tick at the end of its row and says so to screen readers; nothing is put in front of the labels', () => {
    const pick = (label: string, checked: boolean) => ({ label, checked, onSelect: () => {} });
    render(<ContextMenu x={0} y={0} items={[pick('甲', false), pick('乙', true), pick('丙', false)]} onClose={() => {}} />);
    const rows = screen.getAllByRole('menuitemradio');
    expect(rows.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(rows.map((r) => Boolean(r.querySelector('.context-item-check svg')))).toEqual([false, true, false]);
    expect(rows.map((r) => r.querySelectorAll('.context-item-check').length)).toEqual([0, 1, 0]);
    expect(rows.every((r) => r.firstElementChild?.className === 'context-item-label')).toBe(true);
    expect(rows[1]!.lastElementChild?.className).toBe('context-item-check');
    expect(rows.map((r) => r.textContent)).toEqual(['甲', '乙', '丙']);
  });
  it('a menu of actions has no tick place', () => {
    render(<ContextMenu x={0} y={0} items={[{ label: '重命名', onSelect: () => {} }]} onClose={() => {}} />);
    expect(screen.getByRole('menuitem').querySelector('.context-item-check')).toBeNull();
    expect(screen.queryByRole('menuitemradio')).toBeNull();
  });
});

describe('ContextMenu with the keys', () => {
  const items = (pick: (l: string) => void) => [
    { label: '重命名', onSelect: () => pick('重命名') },
    { label: '置顶', disabled: true, title: '不能置顶', onSelect: () => pick('置顶') },
    { label: '删除', danger: true, onSelect: () => pick('删除') },
  ];

  it('Up and Down move between the items that can be picked, round the ends; Enter picks', () => {
    const pick = vi.fn();
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={items(pick)} onClose={onClose} />);
    const [rename, , remove] = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(rename);
    fireEvent.keyDown(rename!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(remove);
    fireEvent.keyDown(remove!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rename);
    fireEvent.keyDown(rename!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(remove);
    expect(screen.getByRole('menu').classList.contains('is-keys')).toBe(true);
    // a focused button picks on Enter by itself (the browser turns it into a click)
    fireEvent.click(remove!);
    expect(pick).toHaveBeenCalledWith('删除');
    expect(onClose).toHaveBeenCalled();
  });

  it('after the pointer moved, the keys start from the item under it and Enter picks that one', () => {
    const pick = vi.fn();
    render(<ContextMenu x={0} y={0} items={items(pick)} onClose={vi.fn()} />);
    const menu = screen.getByRole('menu');
    const [rename, , remove] = screen.getAllByRole('menuitem');
    fireEvent.pointerMove(remove!);
    expect(document.activeElement).toBe(menu);
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(pick).toHaveBeenCalledWith('删除');
    fireEvent.pointerMove(remove!);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rename);
  });

  it('with the pointer moved off the items, Enter picks nothing (nothing is lit)', () => {
    const pick = vi.fn();
    render(<ContextMenu x={0} y={0} items={items(pick)} onClose={vi.fn()} />);
    const menu = screen.getByRole('menu');
    const remove = screen.getAllByRole('menuitem')[2]!;
    fireEvent.pointerMove(remove);
    fireEvent.pointerLeave(remove);
    expect(document.activeElement).toBe(menu);
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(pick).not.toHaveBeenCalled();
  });

  it('an item given an icon draws it before its words; the others keep no place for one', () => {
    render(<ContextMenu x={0} y={0} items={[{ label: '设置', icon: 'settings', onSelect: vi.fn() }, { label: '重命名', onSelect: vi.fn() }]} onClose={vi.fn()} />);
    const [withIcon, plain] = screen.getAllByRole('menuitem');
    const label = withIcon!.querySelector('.context-item-label')!;
    expect(label.firstElementChild?.classList.contains('context-item-icon')).toBe(true);
    expect(label.textContent).toBe('设置');
    expect(plain!.querySelector('.context-item-icon')).toBeNull();
    expect(plain!.querySelector('.has-icon')).toBeNull();
  });
});
