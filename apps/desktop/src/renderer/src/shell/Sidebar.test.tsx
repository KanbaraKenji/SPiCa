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
    expect(screen.getByRole('button', { name: /年度预算.*有新来信/ })).toBeTruthy();
  });

  it('summarises a collapsed project with only non-zero counts', () => {
    const kids = seed.sessions.filter((s) => s.parentId === SEED_IDS.pm);
    expect(projectSummary(kids)).toBe('1 个等你 · 1 个在跑 · 1 个排队');
    expect(projectSummary([])).toBe('');
  });

  it('puts the other assistant threads under the default one', () => {
    const sessions = seed.sessions.map((s) => (s.id === SEED_IDS.chat ? { ...s, title: '助理' } : s));
    render(<Sidebar sessions={sessions} activeId={null} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} topId={SEED_IDS.chat} />);
    expect(screen.queryByRole('heading', { name: '对话' })).toBeNull();
    const top = screen.getByRole('button', { name: '收起 助理' });
    expect(top.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: '整理本周来信' })).toBeTruthy();
    fireEvent.click(top);
    expect(screen.queryByRole('button', { name: '整理本周来信' })).toBeNull();
  });

  it('renames a thread from the right-click menu; Esc cancels; projects have no menu', () => {
    const onRename = vi.fn();
    render(<Sidebar sessions={seed.sessions} activeId={null} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} onRename={onRename} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: '整理本周来信' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));
    const field = screen.getByRole('textbox', { name: '新名字' });
    fireEvent.change(field, { target: { value: '本周来信' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith(SEED_IDS.chat2, '本周来信');

    fireEvent.contextMenu(screen.getByRole('button', { name: '看一下样机评审资料' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: '新名字' }), { key: 'Escape' });
    expect(onRename).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(screen.getByTitle('新品样机评审'));
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('collapsing a project shows the summary instead of children', () => {
    render(<Sidebar sessions={seed.sessions} activeId={null} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: '收起 新品样机评审' }));
    expect(screen.getByText('1 个等你 · 1 个在跑 · 1 个排队')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /汇总测试报告/ })).toBeNull();
  });
});
