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

  it('summarises a collapsed project with only non-zero counts', () => {
    const kids = seed.sessions.filter((s) => s.parentId === SEED_IDS.pm);
    expect(projectSummary(kids)).toBe('1 个等你 · 1 个在跑 · 1 个排队');
    expect(projectSummary([])).toBe('');
  });

  it('collapsing a project shows the summary instead of children', () => {
    render(<Sidebar sessions={seed.sessions} activeId={null} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: '收起 新品样机评审' }));
    expect(screen.getByText('1 个等你 · 1 个在跑 · 1 个排队')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /汇总测试报告/ })).toBeNull();
  });
});
