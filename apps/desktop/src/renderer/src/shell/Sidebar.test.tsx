// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { buildSeed, SEED_IDS } from '../../../main/backend/fake-seed';
import { Sidebar } from './Sidebar';
import type { SessionInfo } from '@spica/protocol';

afterEach(cleanup);

const seed = buildSeed(new Date('2026-11-09T10:00:00+08:00'));

describe('Sidebar', () => {
  it('lists chats and projects; running projects start expanded', () => {
    const onOpen = vi.fn();
    render(<Sidebar sessions={seed.sessions} activeId={SEED_IDS.chat} onOpen={onOpen} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} />);
    expect(screen.getByRole('button', { name: '整理本周来信' })).toBeTruthy();
    // Projects are on their own tab.
    fireEvent.click(screen.getByRole('tab', { name: /^项目/ }));
    // 新品样机评审 has running children, so they are visible.
    fireEvent.click(screen.getByRole('button', { name: /起草评审纪要/ }));
    expect(onOpen).toHaveBeenCalledWith(SEED_IDS.minutes);
    // 年度预算 is quiet, so it starts collapsed.
    expect(screen.queryByRole('button', { name: /核对三季度支出/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开 年度预算' }));
    expect(screen.getByRole('button', { name: /核对三季度支出/ })).toBeTruthy();
  });

  it('shows the inbox with what waits; the tabs carry no dot', () => {
    const onInbox = vi.fn();
    render(<Sidebar sessions={seed.sessions} activeId={SEED_IDS.chat} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} inbox={{ count: 3, open: false, onOpen: onInbox }} />);
    fireEvent.click(screen.getByRole('button', { name: /收件箱/ }));
    expect(onInbox).toHaveBeenCalled();
    expect(screen.getByLabelText('3 封待确认')).toBeTruthy();
    expect(screen.getByRole('tablist').querySelector('[role="img"]')).toBeNull();
    expect(screen.getByRole('tab', { name: '项目' }).textContent).toBe('项目');
  });

  it('without a mail plugin there is no 收件箱', () => {
    render(<Sidebar sessions={seed.sessions} activeId={SEED_IDS.chat} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} />);
    expect(screen.queryByRole('button', { name: /收件箱/ })).toBeNull();
  });

  it('lists every conversation outside a project flat under 对话, the default thread one of them', () => {
    const sessions = seed.sessions.map((s) => (s.id === SEED_IDS.chat ? { ...s, title: '助理' } : s));
    render(<Sidebar sessions={sessions} activeId={null} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} topId={SEED_IDS.chat} />);
    expect(screen.getByRole('tab', { name: '对话' }).getAttribute('aria-selected')).toBe('true');
    // No row is singled out to hold the others.
    expect(screen.queryByRole('button', { name: /^(收起|展开) 助理$/ })).toBeNull();
    expect(screen.getByRole('button', { name: '助理' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '整理本周来信' })).toBeTruthy();
  });

  it('collapsed: one column of actions; the lists (对话, 项目) are not on it', () => {
    const onSettings = vi.fn();
    const onNewChat = vi.fn();
    const onInbox = vi.fn();
    render(
      <Sidebar
        compact
        sessions={seed.sessions}
        activeId={SEED_IDS.chat}
        onOpen={vi.fn()}
        onNewChat={onNewChat}
        onSettings={onSettings}
        settingsOpen={false}
        onNewProject={vi.fn()}
        inbox={{ count: 5, open: false, onOpen: onInbox }}
      />,
    );
    expect(screen.queryByRole('heading', { name: '对话' })).toBeNull();
    expect(screen.queryByRole('button', { name: '对话' })).toBeNull();
    expect(screen.queryByRole('button', { name: '项目' })).toBeNull();
    expect(screen.queryByRole('button', { name: '整理本周来信' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    expect(onNewChat).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '收件箱，5 封待确认' }));
    expect(onInbox).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(onSettings).toHaveBeenCalled();
  });

  it('renames a thread from the right-click menu; Esc cancels; projects have no menu', () => {
    const onRename = vi.fn();
    render(<Sidebar sessions={seed.sessions} activeId={null} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} onRename={onRename} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: '整理本周来信' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));
    const field = screen.getByRole('textbox', { name: '名称' });
    fireEvent.change(field, { target: { value: '本周来信' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith(SEED_IDS.chat2, '本周来信');

    fireEvent.contextMenu(screen.getByRole('button', { name: '看一下样机评审资料' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: '名称' }), { key: 'Escape' });
    expect(onRename).toHaveBeenCalledTimes(1);

    // Without project actions, a project row has no menu.
    fireEvent.click(screen.getByRole('tab', { name: /^项目/ }));
    fireEvent.contextMenu(screen.getByTitle('新品样机评审'));
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('删除 in a conversation’s menu; a project’s conversation and sub-tasks have no such item', () => {
    const onDeleteChat = vi.fn();
    render(<Sidebar sessions={seed.sessions} activeId={null} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} onRename={vi.fn()} onDeleteChat={onDeleteChat} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: '整理本周来信' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['重命名', '删除']);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    expect(onDeleteChat).toHaveBeenCalledWith(expect.objectContaining({ id: SEED_IDS.chat2 }));
    // Under a project: its manager's conversation has no 删除 of its own.
    fireEvent.click(screen.getByRole('tab', { name: /^项目/ }));
    fireEvent.contextMenu(screen.getByTitle('新品样机评审'));
    expect(screen.queryByRole('menuitem', { name: '删除' })).toBeNull();
  });

  it('pins, renames and deletes a project from its menu; pinned ones come first', () => {
    const onPin = vi.fn();
    const onRenameProject = vi.fn();
    const onDeleteProject = vi.fn();
    const props = { sessions: seed.sessions, activeId: null, onOpen: vi.fn(), onNewChat: vi.fn(), onSettings: vi.fn(), settingsOpen: false, onPin, onRenameProject, onDeleteProject };
    const { rerender } = render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole('tab', { name: /^项目/ }));
    const order = () => [...document.querySelectorAll('.tree-section')].at(-1)!.querySelectorAll(':scope > .tree-row .tree-title');
    const names = () => [...order()].map((e) => e.textContent);
    expect(names()[0]).toBe('新品样机评审');
    fireEvent.contextMenu(screen.getByTitle('年度预算'));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['重命名', '置顶', '删除']);
    fireEvent.click(screen.getByRole('menuitem', { name: '置顶' }));
    expect(onPin).toHaveBeenCalledWith('p-budget', true);

    rerender(<Sidebar {...props} pinned={['p-budget']} />);
    expect(names()[0]).toBe('年度预算');
    expect(screen.getByTitle('已置顶')).toBeTruthy();
    fireEvent.contextMenu(screen.getByTitle('年度预算'));
    fireEvent.click(screen.getByRole('menuitem', { name: '取消置顶' }));
    expect(onPin).toHaveBeenCalledWith('p-budget', false);

    fireEvent.contextMenu(screen.getByTitle('年度预算'));
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));
    const field = screen.getByRole('textbox', { name: '名称' });
    // An empty name changes nothing for a project.
    fireEvent.change(field, { target: { value: '  ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onRenameProject).not.toHaveBeenCalled();
    fireEvent.contextMenu(screen.getByTitle('年度预算'));
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '2027 年度预算' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: '名称' }), { key: 'Enter' });
    expect(onRenameProject).toHaveBeenCalledWith('p-budget', '2027 年度预算');

    fireEvent.contextMenu(screen.getByTitle('年度预算'));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    expect(onDeleteProject).toHaveBeenCalledWith('p-budget', '年度预算');
  });

  it('更多 (…) is only on the row that is open, in place of its status; its menu is the right-click one, under the button; again closes it', () => {
    const onOpen = vi.fn();
    const onDeleteChat = vi.fn();
    render(<Sidebar sessions={seed.sessions} activeId={SEED_IDS.chat2} onOpen={onOpen} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} onRename={vi.fn()} onDeleteChat={onDeleteChat} />);
    // One 更多 in the whole list: on the open row, where the status place would be.
    expect(screen.getAllByRole('button', { name: '更多' })).toHaveLength(1);
    const row = screen.getByRole('button', { name: '整理本周来信' }).closest('.tree-row') as HTMLElement;
    const more = within(row).getByRole('button', { name: '更多' });
    expect(row.lastElementChild).toBe(more);
    expect(row.querySelector('.status-slot')).toBeNull();
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    // The other rows keep their status place and have no button, hovered or not.
    const other = screen.getByRole('button', { name: '看一下样机评审资料' }).closest('.tree-row') as HTMLElement;
    fireEvent.mouseEnter(other);
    fireEvent.mouseOver(other);
    expect(within(other).queryByRole('button', { name: '更多' })).toBeNull();
    expect(other.lastElementChild?.className).toMatch(/^status-slot/);

    fireEvent.click(more);
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['重命名', '删除']);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(row.className).toContain('is-menu-open');
    expect(onOpen).not.toHaveBeenCalled();

    // Pressing it again closes the menu (the press is not taken as a click elsewhere).
    fireEvent.pointerDown(more);
    fireEvent.click(more);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(row.className).not.toContain('is-menu-open');

    // A press elsewhere closes it too; an item does what right-click's does.
    fireEvent.click(more);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    expect(onDeleteChat).toHaveBeenCalledWith(expect.objectContaining({ id: SEED_IDS.chat2 }));
  });

  it('a right-click anywhere on any row opens the same menu at the pointer; the row keeps its status place and gets no 更多', () => {
    render(<Sidebar sessions={seed.sessions} activeId={SEED_IDS.chat2} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} onRename={vi.fn()} onPin={vi.fn()} onRenameProject={vi.fn()} onDeleteProject={vi.fn()} onDeleteChat={vi.fn()} />);
    const other = screen.getByRole('button', { name: '看一下样机评审资料' }).closest('.tree-row') as HTMLElement;
    fireEvent.contextMenu(other.querySelector('.status-slot')!, { clientX: 120, clientY: 90 });
    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe('120px');
    expect(menu.style.top).toBe('90px');
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['重命名', '删除']);
    expect(within(other).queryByRole('button', { name: '更多' })).toBeNull();
    expect(other.querySelector('.status-slot')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    // Projects and sub-tasks too, each with its own items.
    fireEvent.click(screen.getByRole('tab', { name: /^项目/ }));
    fireEvent.contextMenu(screen.getByTitle('年度预算'), { clientX: 60, clientY: 200 });
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['重命名', '置顶', '删除']);
    fireEvent.pointerDown(document.body);
    fireEvent.contextMenu(screen.getByRole('button', { name: '起草评审纪要' }), { clientX: 60, clientY: 240 });
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['重命名']);
  });

  it('a double-click on a row edits its name; on its arrow or on 更多 it does not; rows that cannot be renamed ignore it', () => {
    const onRename = vi.fn();
    const props = { sessions: seed.sessions, activeId: SEED_IDS.chat2, onOpen: vi.fn(), onNewChat: vi.fn(), onSettings: vi.fn(), settingsOpen: false };
    const { rerender } = render(<Sidebar {...props} onRename={onRename} onPin={vi.fn()} />);
    const name = screen.getByRole('button', { name: '看一下样机评审资料' });
    fireEvent.doubleClick(name);
    const box = screen.getByRole('textbox', { name: '名称' }) as HTMLInputElement;
    expect(box.value).toBe('看一下样机评审资料');
    fireEvent.change(box, { target: { value: '样机评审' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith(SEED_IDS.chat, '样机评审');
    // 更多 on the open row is a button of its own: a double-click there edits nothing.
    fireEvent.doubleClick(screen.getByRole('button', { name: '更多' }));
    expect(screen.queryByRole('textbox', { name: '名称' })).toBeNull();
    // A project that can only be pinned (no renaming on offer): its row has a menu, but a double-click edits nothing.
    fireEvent.pointerDown(document.body);
    fireEvent.click(screen.getByRole('tab', { name: /^项目/ }));
    fireEvent.doubleClick(screen.getByRole('button', { name: '年度预算' }));
    expect(screen.queryByRole('textbox', { name: '名称' })).toBeNull();
    // The expand arrow: only expands.
    fireEvent.doubleClick(screen.getByRole('button', { name: '展开 年度预算' }));
    expect(screen.queryByRole('textbox', { name: '名称' })).toBeNull();
    // A sub-task can be renamed: the double-click works there.
    fireEvent.doubleClick(screen.getByRole('button', { name: '起草评审纪要' }));
    expect((screen.getByRole('textbox', { name: '名称' }) as HTMLInputElement).value).toBe('起草评审纪要');
    fireEvent.keyDown(screen.getByRole('textbox', { name: '名称' }), { key: 'Escape' });
    // Nothing on offer at all: nothing happens.
    rerender(<Sidebar {...props} />);
    fireEvent.doubleClick(screen.getByRole('button', { name: '年度预算' }));
    expect(screen.queryByRole('textbox', { name: '名称' })).toBeNull();
  });

  it('更多 only where the open row has a menu: none without actions; none while the row is renamed', () => {
    const props = { sessions: seed.sessions, activeId: SEED_IDS.chat2, onOpen: vi.fn(), onNewChat: vi.fn(), onSettings: vi.fn(), settingsOpen: false };
    const { rerender } = render(<Sidebar {...props} />);
    expect(screen.queryAllByRole('button', { name: '更多' })).toHaveLength(0);
    expect(screen.getByRole('button', { name: '整理本周来信' }).closest('.tree-row')!.querySelector('.status-slot')).toBeTruthy();
    rerender(<Sidebar {...props} onRename={vi.fn()} />);
    const row = screen.getByRole('button', { name: '整理本周来信' }).closest('.tree-row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));
    expect(within(row).queryByRole('button', { name: '更多' })).toBeNull();
    expect(within(row).getByRole('textbox', { name: '名称' })).toBeTruthy();
    // Another view (settings, the inbox) is open: no row is the open one, so no 更多.
    rerender(<Sidebar {...props} onRename={vi.fn()} settingsOpen />);
    expect(screen.queryAllByRole('button', { name: '更多' })).toHaveLength(0);
  });

  it('a project’s row shows no state: not its own, not what is below it, open or collapsed; the rows under it show theirs', () => {
    render(<Sidebar sessions={seed.sessions} activeId={null} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} onRename={vi.fn()} unseenDone={new Set([SEED_IDS.budget])} />);
    fireEvent.click(screen.getByRole('tab', { name: /^项目/ }));
    const slotOf = (title: string) => screen.getByTitle(title).closest('.tree-row')!.querySelector('.status-slot') as HTMLElement;
    for (const row of document.querySelectorAll('.tree-row')) {
      // One status place per row, the last thing on it (no row is open here), at the same spot on all of them.
      expect(row.querySelectorAll('.status-slot')).toHaveLength(1);
      expect(row.lastElementChild?.className).toMatch(/^status-slot/);
      expect(row.querySelector('.tree-more')).toBeNull();
    }
    // 新品样机评审 is running and has sub-tasks running, queued and waiting: its own row stays empty.
    for (const project of ['新品样机评审', '年度预算']) {
      expect(slotOf(project).className).toBe('status-slot');
      expect(slotOf(project).getAttribute('aria-hidden')).toBe('true');
      expect(slotOf(project).getAttribute('title')).toBeNull();
    }
    expect(slotOf('起草评审纪要').className).toBe('status-slot is-waiting');
    expect(slotOf('汇总测试报告').className).toBe('status-slot is-queued');
    // Collapsed by hand: still nothing on the project's row.
    fireEvent.click(screen.getByRole('button', { name: '收起 新品样机评审' }));
    expect(screen.queryByRole('button', { name: /汇总测试报告/ })).toBeNull();
    expect(slotOf('新品样机评审').className).toBe('status-slot');
    expect(screen.getByTitle('新品样机评审').closest('.tree-row')!.textContent).toBe('新品样机评审');
    // A finished sub-task not opened yet: the dot is on its own row, under the project.
    fireEvent.click(screen.getByRole('button', { name: '展开 年度预算' }));
    expect(slotOf('年度预算').className).toBe('status-slot');
    expect(slotOf('核对三季度支出').className).toBe('status-slot is-news');
    expect(slotOf('核对三季度支出').getAttribute('aria-label')).toBe('已完成');
  });

  it('a conversation with sub-tasks, collapsed, still shows the most pressing state below it, with the counts on hover', () => {
    const at = '2026-11-09T02:00:00.000Z';
    const one = (id: string, status: SessionInfo['status'], parentId: string | null, title: string): SessionInfo => ({ ...seed.sessions.find((x) => x.id === SEED_IDS.chat)!, id, status, parentId, parentChain: parentId ? [parentId] : [], title, role: parentId ? 'worker' : 'top', createdAt: at, updatedAt: at });
    const list = [one('c', 'tool', null, '翻译说明书'), one('k1', 'awaiting_answer', 'c', '核对术语'), one('k2', 'tool', 'c', '排版'), one('k3', 'queued', 'c', '校对')];
    render(<Sidebar sessions={list} activeId={null} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: '收起 翻译说明书' }));
    const mark = screen.getByTitle('翻译说明书').closest('.tree-row')!.querySelector('.status-slot') as HTMLElement;
    expect(mark.className).toBe('status-slot is-waiting');
    // The counts are over the row itself (it is running too) and everything below it.
    expect(mark.getAttribute('title')).toBe('1 个待处理 · 2 个运行中 · 1 个排队中');
    expect(mark.getAttribute('aria-label')).toBe('1 个待处理 · 2 个运行中 · 1 个排队中');
  });

  it('a finished sub-task already opened shows nothing; so does an idle row', () => {
    render(<Sidebar sessions={seed.sessions} activeId={null} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} />);
    fireEvent.click(screen.getByRole('tab', { name: /^项目/ }));
    fireEvent.click(screen.getByRole('button', { name: '展开 年度预算' }));
    for (const title of ['年度预算', '核对三季度支出']) {
      const slot = screen.getByTitle(title).closest('.tree-row')!.querySelector('.status-slot') as HTMLElement;
      expect(slot.className).toBe('status-slot');
      expect(slot.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('the expand arrow is a button of its own right after the name; it and the arrow keys only expand or collapse', () => {
    const onOpen = vi.fn();
    render(<Sidebar sessions={seed.sessions} activeId={null} onOpen={onOpen} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} />);
    fireEvent.click(screen.getByRole('tab', { name: /^项目/ }));
    const name = screen.getByRole('button', { name: '年度预算' });
    const arrow = screen.getByRole('button', { name: '展开 年度预算' });
    expect(name.nextElementSibling).toBe(arrow);
    expect(name.contains(arrow)).toBe(false);
    expect(arrow.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(arrow);
    expect(screen.getByRole('button', { name: '收起 年度预算' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: '核对三季度支出' })).toBeTruthy();
    fireEvent.keyDown(name, { key: 'ArrowLeft' });
    expect(screen.queryByRole('button', { name: '核对三季度支出' })).toBeNull();
    fireEvent.keyDown(name, { key: 'ArrowRight' });
    expect(screen.getByRole('button', { name: '核对三季度支出' })).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
    // Rows with nothing under them have no arrow.
    expect(screen.queryByRole('button', { name: /^(展开|收起) 核对三季度支出/ })).toBeNull();
    // The status place and the rest of the row open the conversation.
    fireEvent.click(screen.getByTitle('年度预算').closest('.tree-row')!.querySelector('.status-slot')!);
    expect(onOpen).toHaveBeenCalledWith(SEED_IDS.pm2);
  });
});

describe('对话 / 项目 at the top', () => {
  const props = { sessions: seed.sessions, activeId: SEED_IDS.chat, onOpen: vi.fn(), onNewChat: vi.fn(), onSettings: vi.fn(), settingsOpen: false, inbox: { count: 0, open: false, onOpen: vi.fn() } };
  const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('the tabs come first in the sidebar, above 新对话 and 收件箱', () => {
    render(<Sidebar {...props} />);
    const nav = screen.getByRole('navigation');
    expect(nav.firstElementChild).toBe(screen.getByRole('tablist', { name: '列表' }));
    expect(before(screen.getByRole('tablist'), screen.getByRole('button', { name: '新对话' }))).toBe(true);
    expect(before(screen.getByRole('button', { name: '收件箱' }), screen.getByRole('tabpanel'))).toBe(true);
  });

  it('新对话 and 收件箱 scroll with the list (a short window scrolls them away); the tabs, the plugin pages and 设置 stay', () => {
    const pages = [{ key: 'p/v', title: '笔记', open: false, onOpen: vi.fn() }];
    for (const compact of [false, true]) {
      const { unmount } = render(<Sidebar {...props} compact={compact} pluginPages={pages} />);
      const scroller = document.querySelector('.sidebar-scroll')!;
      for (const name of ['新对话', /^收件箱/]) expect(scroller.contains(screen.getByRole('button', { name })), `${String(name)} compact=${compact}`).toBe(true);
      for (const name of ['设置', '笔记']) expect(scroller.contains(screen.getByRole('button', { name })), `${name} compact=${compact}`).toBe(false);
      if (!compact) {
        expect(scroller.contains(screen.getByRole('tabpanel'))).toBe(true);
        expect(scroller.contains(screen.getByRole('tablist'))).toBe(false);
      }
      unmount();
    }
  });

  it('collapsed, the column keeps an empty space where the tabs are, so the icons do not move when the sidebar opens over it', () => {
    render(<Sidebar {...props} compact />);
    const nav = screen.getByRole('navigation');
    expect(nav.firstElementChild?.className).toBe('side-tabs-space');
    expect(nav.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});

describe('the account on the bottom row', () => {
  const base = { sessions: seed.sessions, activeId: SEED_IDS.chat, onOpen: vi.fn(), onNewChat: vi.fn(), settingsOpen: false };

  it('its letter and the account, then the gear, which opens the settings', () => {
    const onAccount = vi.fn();
    const onSettings = vi.fn();
    const { container } = render(<Sidebar {...base} onSettings={onSettings} account="ALEX.CHEN" onAccount={onAccount} />);
    const me = screen.getByRole('button', { name: '账号 ALEX.CHEN' });
    expect(me.textContent).toBe('AALEX.CHEN');
    expect(me.getAttribute('title')).toBe('ALEX.CHEN');
    expect(me.querySelector('.side-avatar')?.textContent).toBe('A');
    const gear = screen.getByRole('button', { name: '设置' });
    expect(gear.getAttribute('title')).toBe('设置');
    fireEvent.click(gear);
    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(onAccount).not.toHaveBeenCalled();
    // one row: both in the bottom part, the account first
    const bottom = container.querySelector('.sidebar-bottom.has-account')!;
    expect([...bottom.querySelectorAll('button')]).toEqual([me, gear]);
  });

  it('a click on the account opens its menu above: the account in full, 设置, 模型设定 and 监控台; a second click closes it', () => {
    const onAccount = vi.fn();
    render(<Sidebar {...base} onSettings={vi.fn()} account="ALEX.CHEN" onAccount={onAccount} />);
    const me = screen.getByRole('button', { name: '账号 ALEX.CHEN' });
    expect(me.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(me);
    const menu = screen.getByRole('menu');
    expect(me.getAttribute('aria-expanded')).toBe('true');
    expect(menu.querySelector('.context-group')?.textContent).toBe('ALEX.CHEN');
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['设置', '模型设定', '监控台']);
    // each with its settings page's icon
    expect(screen.getAllByRole('menuitem').map((b) => b.querySelectorAll('.account-menu-icon').length)).toEqual([1, 1, 1]);
    expect(onAccount).not.toHaveBeenCalled();
    fireEvent.click(me);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('each item opens the settings where it says and closes the menu', () => {
    const onAccount = vi.fn();
    render(<Sidebar {...base} onSettings={vi.fn()} account="ALEX.CHEN" onAccount={onAccount} />);
    const me = screen.getByRole('button', { name: '账号 ALEX.CHEN' });
    fireEvent.click(me);
    fireEvent.click(screen.getByRole('menuitem', { name: '模型设定' }));
    expect(onAccount).toHaveBeenLastCalledWith('models');
    fireEvent.click(me);
    fireEvent.click(screen.getByRole('menuitem', { name: '监控台' }));
    expect(onAccount).toHaveBeenLastCalledWith('monitor');
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(me);
    fireEvent.click(screen.getByRole('menuitem', { name: '设置' }));
    expect(onAccount).toHaveBeenLastCalledWith('settings');
  });

  it('by keyboard: the first item has the focus (the others by Tab, as in every menu), Esc closes', () => {
    render(<Sidebar {...base} onSettings={vi.fn()} account="ALEX.CHEN" onAccount={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '账号 ALEX.CHEN' }));
    const [settings] = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(settings);
    fireEvent.keyDown(settings!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('no account: the row is 设置 alone, as it was, with no empty badge', () => {
    const { container } = render(<Sidebar {...base} onSettings={vi.fn()} account="" />);
    expect(screen.queryByRole('button', { name: /^账号/ })).toBeNull();
    expect(screen.getByRole('button', { name: '设置' }).textContent).toBe('设置');
    expect(container.querySelector('.side-avatar')).toBeNull();
  });

  it('the column of icons keeps only the gear', () => {
    const { container } = render(<Sidebar {...base} onSettings={vi.fn()} account="ALEX.CHEN" compact />);
    expect(screen.queryByRole('button', { name: /^账号/ })).toBeNull();
    expect(screen.getByRole('button', { name: '设置' })).toBeTruthy();
    expect(container.querySelector('.side-avatar')).toBeNull();
  });
});
