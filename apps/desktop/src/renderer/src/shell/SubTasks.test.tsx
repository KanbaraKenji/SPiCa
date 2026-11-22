// @vitest-environment jsdom
// A project holding sub-projects in the sidebar, a manager's 子任务 in the details.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectInfo, SessionInfo } from '@spica/protocol';
import { buildSeed, SUB_IDS, SUB_PROJECTS } from '../../../main/backend/fake-seed';
import { DetailPanel } from './DetailPanel';
import { Sidebar } from './Sidebar';
import { NewProjectDialog } from './NewProjectDialog';
import { ProjectPage } from './ProjectPage';
import { tasksInOrder } from './SubTasks';
import type { Transcript } from '../store/transcript';

afterEach(cleanup);

const now = new Date('2026-11-21T12:00:00.000Z');
const seed = buildSeed(now);
const byId = (id: string) => seed.sessions.find((s) => s.id === id)!;
const projects: ProjectInfo[] = SUB_PROJECTS.map((p) => ({ ...p, folder: p.folder ?? '', workflowId: null, stage: null, status: 'active', createdAt: now.toISOString(), updatedAt: now.toISOString() }));
const tasksOf = (id: string) => seed.sessions.filter((s) => s.parentId === id);
const empty = { items: [] } as unknown as Transcript;

describe('项目 › 子项目', () => {
  it('a project holding sub-projects opens its page; its sub-projects are its rows; sub-tasks are not rows', () => {
    const onOpen = vi.fn();
    const onOpenProject = vi.fn();
    render(<Sidebar sessions={seed.sessions} activeId={null} onOpen={onOpen} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} projectInfos={projects} onOpenProject={onOpenProject} projectPageId="p-models" />);
    // the page open: 项目 is the tab shown
    expect(screen.getByRole('tab', { name: '项目' }).getAttribute('aria-selected')).toBe('true');
    const rows = [...document.querySelectorAll('.tree-title')].map((x) => x.textContent);
    expect(rows).toEqual(expect.arrayContaining(['机种', '磁件 T1', '磁件 L1', '磁件 L2', '游戏攻略', '怪物猎人: 冰原']));
    expect(rows.indexOf('磁件 T1')).toBeLessThan(rows.indexOf('磁件 L2'));
    expect(rows).not.toContain('查报价');
    fireEvent.click(screen.getByText('机种'));
    expect(onOpenProject).toHaveBeenCalledWith('p-models');
    fireEvent.click(screen.getByText('磁件 T1'));
    expect(onOpen).toHaveBeenCalledWith(SUB_IDS.t1);
  });
});

describe('新子项目', () => {
  it("a project's menu offers 新子项目 (its row holding sub-projects too); a sub-project's does not", () => {
    const onNewSub = vi.fn();
    const onRenameProject = vi.fn();
    render(<Sidebar sessions={seed.sessions} activeId={null} onOpen={vi.fn()} onNewChat={vi.fn()} onSettings={vi.fn()} settingsOpen={false} projectInfos={projects} onOpenProject={vi.fn()} projectPageId="p-models" onNewSubProject={onNewSub} onRenameProject={onRenameProject} />);
    fireEvent.contextMenu(screen.getByText('机种'));
    fireEvent.click(screen.getByRole('menuitem', { name: '新子项目' }));
    expect(onNewSub).toHaveBeenCalledWith('p-models');
    fireEvent.contextMenu(screen.getByText('磁件 T1'));
    expect(screen.queryByRole('menuitem', { name: '新子项目' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: '重命名' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    // the holder's name is renamed in place, as a project's
    fireEvent.doubleClick(screen.getByText('机种'));
    const field = screen.getByRole('textbox', { name: '名称' });
    fireEvent.change(field, { target: { value: '机种 2' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onRenameProject).toHaveBeenCalledWith('p-models', '机种 2');
  });

  it('the project page: its sub-projects, 新子项目 under them; its own conversation when it has one', () => {
    const onNew = vi.fn();
    const onOpen = vi.fn();
    const models = projects.find((p) => p.id === 'p-models')!;
    const t1 = projects.find((p) => p.managerSessionId === SUB_IDS.t1)!;
    const own = byId(SUB_IDS.l2);
    render(<ProjectPage project={models} subs={[{ project: t1, manager: byId(SUB_IDS.t1), below: [] }]} own={{ manager: own, below: [] }} activity={[]} onOpenSession={onOpen} onOpenFolder={vi.fn()} onNewSubProject={onNew} />);
    fireEvent.click(screen.getByText('新子项目'));
    expect(onNew).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '机种' }));
    expect(onOpen).toHaveBeenCalledWith(SUB_IDS.l2);
  });

  it('the dialog for a sub-project names its project and puts the folder inside it', async () => {
    const onCreate = vi.fn(async () => null);
    render(<NewProjectDialog parent={{ name: '机种', folder: 'D:\\工作\\机种' }} onPickFolder={async () => null} onCreate={onCreate} onClose={vi.fn()} />);
    expect(screen.getByText('新子项目')).toBeTruthy();
    expect(screen.getByText('机种')).toBeTruthy();
    expect(screen.getByPlaceholderText('默认：…\\机种\\名称')).toBeTruthy();
  });
});

describe('详情 › 子任务', () => {
  it('the going ones first (kept-for-later with them, saying 常驻), the ended ones folded under N 个已结束', () => {
    const { going, ended } = tasksInOrder(tasksOf(SUB_IDS.t1));
    expect(going.map((s) => s.title)).toEqual(['追踪样制', '查报价', '查旧料参考']);
    expect(ended.map((s) => s.title)).toEqual(['汇总温升数据', '核对绕线参数', '整理规格书', '比对磁芯规格']);
    const t1 = byId(SUB_IDS.t1);
    render(<DetailPanel session={t1} parent={undefined} transcript={empty} globalCostUsd={0} onOpenFile={vi.fn()} onOpenSession={vi.fn()} subTasks={{ tasks: tasksOf(SUB_IDS.t1), transcriptOf: () => empty, load: vi.fn(), stop: vi.fn(), open: vi.fn() }} />);
    expect(screen.getByText('常驻')).toBeTruthy();
    expect(screen.queryByText('整理规格书')).toBeNull();
    fireEvent.click(screen.getByText('4 个已结束'));
    expect(screen.getByText('整理规格书')).toBeTruthy();
    // 停止 only on the ones going (not on the one kept for later, nor the ended ones)
    expect(screen.getAllByRole('button', { name: /^停止 / }).map((b) => b.getAttribute('aria-label'))).toEqual(['停止 查报价', '停止 查旧料参考']);
  });

  it('a click shows that sub-task in the details: what it was asked, its calls, its report; ← 子任务 goes back', () => {
    const load = vi.fn();
    const open = vi.fn();
    const spec: Transcript = {
      items: [
        { kind: 'user', id: 'u', text: '把 T1 规格书整理成一页摘要' },
        { kind: 'response', id: 'r', blocks: [{ type: 'tool', callId: 'c1', name: 'read_file', input: { path: 'T1 规格书 v2.pdf' }, state: 'done' }, { type: 'text', text: '摘要写好了' }] },
      ],
    } as unknown as Transcript;
    const t1 = byId(SUB_IDS.t1);
    render(<DetailPanel session={t1} parent={undefined} transcript={empty} globalCostUsd={0} onOpenFile={vi.fn()} onOpenSession={vi.fn()} subTasks={{ tasks: tasksOf(SUB_IDS.t1), transcriptOf: (id) => (id === SUB_IDS.spec ? spec : empty), load, stop: vi.fn(), open }} />);
    fireEvent.click(screen.getByText('4 个已结束'));
    fireEvent.click(screen.getByText('整理规格书'));
    expect(load).toHaveBeenCalledWith(SUB_IDS.spec);
    expect(screen.getByText('把 T1 规格书整理成一页摘要')).toBeTruthy();
    expect(screen.getByText('摘要写好了')).toBeTruthy();
    expect(screen.queryByText('项目动态')).toBeNull();
    fireEvent.click(screen.getByText('打开对话'));
    expect(open).toHaveBeenCalledWith(SUB_IDS.spec);
    fireEvent.click(screen.getByRole('button', { name: '子任务' }));
    expect(screen.getByText('类型')).toBeTruthy();
  });

  it('a conversation without sub-tasks has no section', () => {
    const chat = { ...byId(SUB_IDS.l2) } as SessionInfo;
    render(<DetailPanel session={chat} parent={undefined} transcript={empty} globalCostUsd={0} onOpenFile={vi.fn()} onOpenSession={vi.fn()} subTasks={{ tasks: [], transcriptOf: () => empty, load: vi.fn(), stop: vi.fn(), open: vi.fn() }} />);
    expect(screen.queryByText('子任务')).toBeNull();
  });
});
