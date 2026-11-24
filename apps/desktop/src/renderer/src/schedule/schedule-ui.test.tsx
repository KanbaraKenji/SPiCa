// @vitest-environment jsdom
// 定时任务 in the window: the line above a run's prompt, the store following the core's events, the sidebar item (also
// in the column of icons), the list page, and the cards in 收件箱.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentApi, CoreEvent, Message, ScheduleInfo, ScheduleRun } from '@spica/protocol';
import { scheduleRunNote } from '../store/transcript';
import { SchedulesStore, schedulesNeedingYou } from '../store/schedules';
import { Sidebar } from '../shell/Sidebar';
import { RunCards, SchedulePage } from './ScheduleViews';

afterEach(cleanup);

const now = new Date(2026, 10, 22, 15, 0);
const task = (over: Partial<ScheduleInfo> = {}): ScheduleInfo => ({
  id: 'sch_1',
  title: '每日报表',
  prompt: 'p',
  trigger: { type: 'time', repeat: { kind: 'daily', time: '09:00' } },
  enabled: true,
  nextAt: new Date(2026, 10, 23, 9).toISOString(),
  failures: 0,
  createdBy: 'user',
  createdAt: '',
  updatedAt: '',
  ...over,
});
const run = (over: Partial<ScheduleRun> = {}): ScheduleRun => ({ id: 'run_1', scheduleId: 'sch_1', dueAt: new Date(2026, 10, 22, 9).toISOString(), startedAt: '', status: 'done', sessionId: 'ses_r', ...over });

describe('a run in the conversation', () => {
  it('has a line above its prompt: the task and when it was due, 补跑 when it ran late', () => {
    const today = new Date();
    const due = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 0).toISOString();
    const msg = (late: boolean): Message => ({ id: 'm1', sessionId: 's', seq: 1, role: 'user', kind: 'user', content: [{ type: 'text', text: 'p' }], createdAt: due, meta: { author: 'runtime', scheduleRun: { scheduleId: 'sch_1', runId: 'r', title: '每日报表', dueAt: due, ...(late ? { late: true } : {}) } } });
    expect(scheduleRunNote(msg(false))).toMatchObject({ kind: 'note', text: '定时任务「每日报表」 · 今天 09:00' });
    expect(scheduleRunNote(msg(true))).toMatchObject({ text: '定时任务「每日报表」 · 今天 09:00 · 补跑' });
    expect(scheduleRunNote({ ...msg(false), meta: { author: 'user' } })).toBeUndefined();
  });
});

describe('the store', () => {
  it('loads the tasks and follows the core: a change, a removal; a run waiting or a task off after failing needs the user', async () => {
    let emit: (e: CoreEvent) => void = () => undefined;
    const agent = { listSchedules: vi.fn(async () => [task()]) } as unknown as AgentApi;
    const store = new SchedulesStore({ agent, onAgentEvent: (l) => ((emit = l), () => undefined) });
    await store.reload();
    expect(store.state.get()).toMatchObject({ loaded: true, items: [{ id: 'sch_1' }] });
    const ev = (body: object) => emit({ seq: 1, at: '', sessionId: '', parentChain: [], ...body } as unknown as CoreEvent);
    ev({ type: 'schedule.changed', schedule: task({ id: 'sch_2', title: '周报', lastRun: run({ scheduleId: 'sch_2', status: 'waiting' }) }) });
    ev({ type: 'schedule.changed', schedule: task({ enabled: false, nextAt: null, failures: 3, pausedAfterFailures: true, lastRun: run({ status: 'failed', reason: 'error' }) }) });
    expect(store.state.get().items.map((s) => s.title)).toEqual(['每日报表', '周报']);
    expect(schedulesNeedingYou(store.state.get().items).map((s) => s.id)).toEqual(['sch_1', 'sch_2']);
    ev({ type: 'schedule.deleted', id: 'sch_2' });
    expect(store.state.get().items.map((s) => s.id)).toEqual(['sch_1']);
  });
});

describe('where it is', () => {
  const base = { sessions: [], activeId: null, onOpen: vi.fn(), onNewChat: vi.fn(), onSettings: vi.fn(), settingsOpen: false };
  it('is a row under 收件箱 in the sidebar, and an icon in the column of icons', () => {
    const onOpen = vi.fn();
    render(<Sidebar {...base} inbox={{ count: 0, open: false, onOpen: vi.fn() }} schedule={{ open: false, onOpen }} />);
    fireEvent.click(screen.getByRole('button', { name: '定时任务' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    cleanup();
    render(<Sidebar {...base} compact schedule={{ open: true, onOpen }} />);
    const icon = screen.getByRole('button', { name: '定时任务' });
    expect(icon.getAttribute('aria-current')).toBe('page');
    expect(icon.textContent).toBe('');
  });
});

describe('the list page', () => {
  const props = { now, onNew: vi.fn(), onEdit: vi.fn(), onToggle: vi.fn(), onRunNow: vi.fn(), onDelete: vi.fn(), onOpenSession: vi.fn() };
  it('says nothing before the list came back, then 没有定时任务 when empty', () => {
    render(<SchedulePage {...props} loaded={false} items={[]} />);
    expect(screen.queryByText('没有定时任务')).toBeNull();
    cleanup();
    render(<SchedulePage {...props} loaded items={[]} />);
    expect(screen.getByText('没有定时任务')).toBeTruthy();
  });

  it('a task off after failing says so once: the red mark, its line only how it repeats, the switch off', () => {
    render(<SchedulePage {...props} loaded items={[task({ enabled: false, nextAt: null, failures: 3, pausedAfterFailures: true, lastRun: run({ status: 'failed', reason: 'error' }) })]} />);
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('连续 3 次失败')).toBeTruthy();
    expect(within(row).getByText('每天 09:00')).toBeTruthy();
    expect(within(row).queryByText('失败')).toBeNull();
    expect(within(row).queryByText(/已暂停/)).toBeNull();
    expect(within(row).getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('更多: 立即运行, 编辑, 打开上次运行, 删除 (asked first); a row opens its last run', () => {
    const p = { ...props, onRunNow: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onOpenSession: vi.fn() };
    render(<SchedulePage {...p} loaded items={[task({ lastRun: run() })]} />);
    fireEvent.click(screen.getByRole('button', { name: /每日报表/ }));
    expect(p.onOpenSession).toHaveBeenCalledWith('ses_r');
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['立即运行', '编辑', '打开上次运行', '删除']);
    fireEvent.click(screen.getByRole('menuitem', { name: '立即运行' }));
    expect(p.onRunNow).toHaveBeenCalledWith('sch_1');
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    expect(p.onDelete).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '删除' }));
    expect(p.onDelete).toHaveBeenCalledWith('sch_1');
  });
});

describe('收件箱', () => {
  it('with no mail plugin shows only the 定时任务 cards: no tabs, no mail status, no 没有邮件', async () => {
    const { InboxView } = await import('../shell/InboxView');
    const { DEFAULT_SETTINGS } = await import('../../../shared/settings');
    const mail = { supported: true, loaded: true, items: [], polling: false, lastPolledAt: null, lastAdded: null, problem: '', threadId: null, flagged: [], triageModel: null };
    const noop = vi.fn();
    render(<InboxView mailShown={false} mail={mail} prefs={DEFAULT_SETTINGS.mail} projects={[]} onPoll={noop} onAccept={noop} onIgnore={noop} onMove={noop} onOpenSession={noop} onOpenSettings={noop} onDismissProblem={noop} before={<RunCards now={now} onOpen={noop} onResume={noop} items={[task({ lastRun: run({ status: 'waiting' }) })]} />} />);
    expect(screen.getByRole('article', { name: '每日报表' })).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByText('没有邮件')).toBeNull();
    expect(screen.queryByText(/邮件分类/)).toBeNull();
  });

  it('a folder that is not there: the form is told so in its own words', async () => {
    const agent = { listSchedules: vi.fn(async () => []), saveSchedule: vi.fn(async () => Promise.reject(new Error('folder_missing: the folder does not exist (D:/x)'))) } as unknown as AgentApi;
    const store = new SchedulesStore({ agent, onAgentEvent: () => () => undefined });
    expect(await store.save({ title: 't', prompt: 'p', trigger: { type: 'time', repeat: { kind: 'daily', time: '09:00' } }, cwd: 'D:/x' })).toBe('文件夹不存在');
  });

  it('has a card for a run waiting for a confirmation (打开) and for a task off after failing (重新开启, 打开)', () => {
    const onOpen = vi.fn();
    const onResume = vi.fn();
    render(<RunCards now={now} onOpen={onOpen} onResume={onResume} items={[task({ title: '来单汇总', lastRun: run({ status: 'waiting', sessionId: 'ses_w' }) }), task({ id: 'sch_2', title: '备份', enabled: false, failures: 3, pausedAfterFailures: true, lastRun: run({ scheduleId: 'sch_2', status: 'failed', detail: 'HTTP 400' }) })]} />);
    const [waiting, failed] = screen.getAllByRole('article');
    expect(within(waiting!).getByText('等待确认')).toBeTruthy();
    fireEvent.click(within(waiting!).getByRole('button', { name: '打开' }));
    expect(onOpen).toHaveBeenCalledWith('ses_w');
    expect(within(failed!).getByText('连续 3 次失败')).toBeTruthy();
    expect(within(failed!).getByText('运行出错')).toBeTruthy();
    fireEvent.click(within(failed!).getByRole('button', { name: '重新开启' }));
    expect(onResume).toHaveBeenCalledWith('sch_2');
  });
});
