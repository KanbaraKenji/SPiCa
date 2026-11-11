// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionInfo } from '@spica/protocol';
import { canRename, commitRename, hasRowMenu, RenameField, rowMenuItems, type RowActions } from './row-menu';

afterEach(cleanup);

const s = (over: Partial<SessionInfo>) => ({ id: 'x', role: 'top', parentId: null, title: '旧名', ...over }) as SessionInfo;
const chat = s({ id: 'c' });
const sub = s({ id: 'k', role: 'worker', parentId: 'c' });
const project = s({ id: 'm', role: 'manager', projectId: 'p1', title: '年度预算' });

describe('what a session’s name offers', () => {
  it('follows the actions the app has: nothing without them', () => {
    const none: RowActions = { pinned: [] };
    for (const x of [chat, sub, project]) {
      expect(hasRowMenu(x, none)).toBe(false);
      expect(canRename(x, none)).toBe(false);
      expect(rowMenuItems(x, none, () => {})).toEqual([]);
    }
  });

  it('a conversation: 重命名, and 删除 only for one the user started; a sub-task: 重命名', () => {
    const a: RowActions = { pinned: [], onRename: vi.fn(), onDeleteChat: vi.fn() };
    expect(rowMenuItems(chat, a, () => {}).map((i) => i.label)).toEqual(['重命名', '删除']);
    expect(rowMenuItems(sub, a, () => {}).map((i) => i.label)).toEqual(['重命名']);
    expect(canRename(chat, a) && canRename(sub, a)).toBe(true);
    // Only delete on offer: a menu, but no renaming.
    const onlyDelete: RowActions = { pinned: [], onDeleteChat: vi.fn() };
    expect(hasRowMenu(chat, onlyDelete)).toBe(true);
    expect(canRename(chat, onlyDelete)).toBe(false);
    expect(hasRowMenu(sub, onlyDelete)).toBe(false);
  });

  it('a project: 重命名, 置顶 or 取消置顶, 删除; 重命名 starts the edit where the menu was opened', () => {
    const start = vi.fn();
    const a: RowActions = { pinned: ['p1'], onPin: vi.fn(), onRenameProject: vi.fn(), onDeleteProject: vi.fn() };
    const items = rowMenuItems(project, a, start);
    expect(items.map((i) => i.label)).toEqual(['重命名', '取消置顶', '删除']);
    items[0]!.onSelect();
    expect(start).toHaveBeenCalledTimes(1);
    items[1]!.onSelect();
    expect(a.onPin).toHaveBeenCalledWith('p1', false);
    items[2]!.onSelect();
    expect(a.onDeleteProject).toHaveBeenCalledWith('p1', '年度预算');
    expect(rowMenuItems(project, { ...a, pinned: [] }, start)[1]!.label).toBe('置顶');
  });

  it('taking the new name: cancelled or unchanged does nothing; a conversation may go back to its automatic name, a project keeps one', () => {
    const a: RowActions = { pinned: [], onRename: vi.fn(), onRenameProject: vi.fn() };
    commitRename(chat, null, a);
    commitRename(chat, ' 旧名 ', a);
    expect(a.onRename).not.toHaveBeenCalled();
    commitRename(chat, ' 新名 ', a);
    expect(a.onRename).toHaveBeenLastCalledWith('c', '新名');
    commitRename(chat, '  ', a);
    expect(a.onRename).toHaveBeenLastCalledWith('c', null);
    commitRename(project, '', a);
    expect(a.onRenameProject).not.toHaveBeenCalled();
    commitRename(project, '预算 2027', a);
    expect(a.onRenameProject).toHaveBeenCalledWith('p1', '预算 2027');
  });
});

describe('the name edited in place', () => {
  it('Enter takes it, Esc cancels, leaving the field takes it; only once', () => {
    const onDone = vi.fn();
    render(<RenameField initial="旧名" onDone={onDone} className="input titlebar-rename" />);
    const box = screen.getByRole('textbox', { name: '名称' }) as HTMLInputElement;
    expect(box.className).toBe('input titlebar-rename');
    expect(box.value).toBe('旧名');
    fireEvent.change(box, { target: { value: '新名' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.blur(box);
    expect(onDone.mock.calls).toEqual([['新名']]);
    cleanup();
    const again = vi.fn();
    render(<RenameField initial="旧名" onDone={again} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '名称' }), { key: 'Escape' });
    expect(again.mock.calls).toEqual([[null]]);
  });
});
