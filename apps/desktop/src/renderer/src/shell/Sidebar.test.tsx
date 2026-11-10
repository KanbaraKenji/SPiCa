// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildSeed, SEED_IDS } from '../../../main/backend/fake-seed';
import { projectSummary, Sidebar } from './Sidebar';

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

  it('shows the inbox with what waits, and 有新来信 on a project', () => {
    const onInbox = vi.fn();
    render(
      <Sidebar
        sessions={seed.sessions}
        activeId={SEED_IDS.chat}
        onOpen={vi.fn()}
        onNewChat={vi.fn()}
        onSettings={vi.fn()}
        settingsOpen={false}
        inbox={{ count: 3, open: false, onOpen: onInbox }}
        notes={new Map([[SEED_IDS.pm2, '有新来信']])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /收件箱/ }));
    expect(onInbox).toHaveBeenCalled();
    expect(screen.getByLabelText('3 封待确认')).toBeTruthy();
    // The 项目 tab, not shown, says it has news.
    expect(screen.getByRole('tab', { name: /项目/ }).querySelector('.tab-dot')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^项目/ }));
    expect(screen.getByRole('button', { name: /年度预算.*有新来信/ })).toBeTruthy();
  });

  it('summarises a collapsed project with only non-zero counts', () => {
    const kids = seed.sessions.filter((s) => s.parentId === SEED_IDS.pm);
    expect(projectSummary(kids)).toBe('1 个待处理 · 1 个运行中 · 1 个排队中');
    expect(projectSummary([])).toBe('');
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

  it('collapsed: one column of icons; 对话 and 项目 open their lists, the rest act as in the full sidebar', () => {
    const onOpen = vi.fn();
    const onSettings = vi.fn();
    const onNewChat = vi.fn();
    const onInbox = vi.fn();
    render(
      <Sidebar
        compact
        sessions={seed.sessions}
        activeId={SEED_IDS.chat}
        onOpen={onOpen}
        onNewChat={onNewChat}
        onSettings={onSettings}
        settingsOpen={false}
        onNewProject={vi.fn()}
        inbox={{ count: 5, open: false, onOpen: onInbox }}
      />,
    );
    expect(screen.queryByRole('heading', { name: '对话' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    expect(onNewChat).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '收件箱，5 封待确认' }));
    expect(onInbox).toHaveBeenCalled();
    // The open conversation is outside a project: 对话 is the current one.
    expect(screen.getByRole('button', { name: '对话' }).className).toContain('is-active');
    fireEvent.click(screen.getByRole('button', { name: '对话' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '整理本周来信' }));
    expect(onOpen).toHaveBeenCalledWith(SEED_IDS.chat2);
    fireEvent.click(screen.getByRole('button', { name: '项目' }));
    expect(screen.getByRole('menuitem', { name: '新品样机评审' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '新项目' })).toBeTruthy();
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

  it('collapsing a project shows the summary instead of children', () => {
    render(<Sidebar sessions={seed.sessions} activeId={null} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} />);
    fireEvent.click(screen.getByRole('tab', { name: /^项目/ }));
    fireEvent.click(screen.getByRole('button', { name: '收起 新品样机评审' }));
    expect(screen.getByText('1 个待处理 · 1 个运行中 · 1 个排队中')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /汇总测试报告/ })).toBeNull();
  });
});
