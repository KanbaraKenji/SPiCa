// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { MemoryItem, MemoryTidyRun } from '@spica/protocol';
import { Memory, MEMORY_CHARS, type MemoryProps, type MemoryTidy } from './Memory';

afterEach(cleanup);

const item = (id: number, over: Partial<MemoryItem> = {}): MemoryItem => ({
  id,
  owner: 'user',
  text: `第 ${id} 条`,
  quote: `原话 ${id}`,
  status: 'active',
  sessionId: 'ses_a',
  seq: 3,
  by: 'assistant',
  createdAt: '2026-11-11T07:59:00+08:00',
  updatedAt: '2026-11-11T07:59:00+08:00',
  ...over,
});

function setup(over: Partial<MemoryProps> = {}) {
  const props: MemoryProps = {
    items: [item(1), item(2, { status: 'replaced' }), item(3), item(4, { sessionId: 'ses_gone' }), item(5, { by: 'user', sessionId: undefined, quote: '第 5 条' })],
    enabled: true,
    onEnabled: vi.fn(),
    api: { add: vi.fn(async () => undefined), edit: vi.fn(async () => undefined), forget: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) },
    titleOf: (id) => (id === 'ses_a' ? '周三下午的安排' : undefined),
    onOpenSession: vi.fn(),
    ...over,
  };
  render(<Memory {...props} />);
  return props;
}

const rows = () => [...document.querySelectorAll('.memory-row .memory-text')].map((e) => e.textContent);

describe('设置 › 记忆', () => {
  it('lists the active items newest first; the conversation it came from opens at the message; none when it is gone or added here', () => {
    const p = setup();
    expect(rows()).toEqual(['第 5 条', '第 4 条', '第 3 条', '第 1 条']);
    const links = screen.getAllByRole('button', { name: '周三下午的安排' });
    expect(links).toHaveLength(2);
    fireEvent.click(links[0]!);
    expect(p.onOpenSession).toHaveBeenCalledWith('ses_a', 3);
    const row4 = document.querySelectorAll('.memory-row')[1]!;
    expect(within(row4 as HTMLElement).queryByRole('button', { name: '周三下午的安排' })).toBeNull();
  });

  it('the switch is the setting; off, the list stays', () => {
    const p = setup({ enabled: false });
    fireEvent.click(screen.getByRole('switch', { name: '启用记忆' }));
    expect(p.onEnabled).toHaveBeenCalledWith(true);
    expect(rows()).toHaveLength(4);
  });

  it('empty: 暂无记忆, 添加 still there, no 全部清除', () => {
    setup({ items: [] });
    expect(screen.getByText('暂无记忆')).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '全部清除' })).toBeNull();
  });

  it('编辑 shows the user\'s words only for an item saved in a conversation', () => {
    setup();
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[2]!);
    expect(screen.getByText('原话：「原话 3」')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!);
    expect(screen.queryByText(/原话：/)).toBeNull();
  });

  it('编辑 saves the new words; a refusal stays in the form with its reason', async () => {
    const edit = vi.fn(async () => ({ refused: 'secret' as const }));
    setup({ api: { add: vi.fn(), edit, forget: vi.fn(), clear: vi.fn() } });
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[2]!);
    const box = screen.getByRole('textbox', { name: '记忆内容' });
    fireEvent.change(box, { target: { value: '邮箱密码是 hunter2' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存' })));
    expect(edit).toHaveBeenCalledWith(3, '邮箱密码是 hunter2');
    expect(screen.getByRole('alert').textContent).toBe('疑似密码、密钥或证件号码，未保存');
    fireEvent.change(box, { target: { value: '周三下午在实验室' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('添加 opens an empty form on top; too long says so and cannot be saved; saved, the form closes', async () => {
    const add = vi.fn(async () => ({ action: 'saved' as const, item: item(6) }));
    setup({ api: { add, edit: vi.fn(), forget: vi.fn(), clear: vi.fn() } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    const box = screen.getByRole('textbox', { name: '记忆内容' }) as HTMLTextAreaElement;
    expect(box.value).toBe('');
    expect(document.querySelector('.memory-list')!.firstElementChild!.contains(box)).toBe(true);
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: '长'.repeat(MEMORY_CHARS + 1) } });
    expect(screen.getByRole('alert').textContent).toBe(`超过 ${MEMORY_CHARS} 字，未保存`);
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: '周报每周五下午发' } });
    await act(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    expect(add).toHaveBeenCalledWith('周报每周五下午发');
    expect(screen.queryByRole('textbox', { name: '记忆内容' })).toBeNull();
  });

  it('删除 and 全部清除 ask first', () => {
    const p = setup();
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[1]!);
    expect(screen.getByText('删除这条记忆？')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '删除' }));
    expect(p.api.forget).toHaveBeenCalledWith(4);
    fireEvent.click(screen.getByRole('button', { name: '全部清除' }));
    expect(screen.getByText('清除全部 4 条记忆？')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '全部清除' }));
    expect(p.api.clear).toHaveBeenCalled();
  });
});

describe('设置 › 记忆 › 整理', () => {
  const run = (over: Partial<MemoryTidyRun> = {}): MemoryTidyRun => ({
    id: 7,
    by: 'user',
    status: 'done',
    startedAt: '2026-11-12T03:10:00+08:00',
    endedAt: '2026-11-12T03:10:20+08:00',
    sessions: 3,
    messages: 12,
    refused: 1,
    changes: [
      { action: 'rewritten', item: item(10, { text: '数据处理主要用 Julia' }), previous: [item(1, { text: '数据处理主要用 Python' })] },
      { action: 'merged', item: item(11, { text: '回答简短' }), previous: [item(2, { text: '喜欢简短回答' }), item(3, { text: '回答要短一点' })] },
      { action: 'added', item: item(12, { text: '负责开单系统' }), undone: true },
      { action: 'forgotten', item: item(4, { text: '周报每周五发' }) },
    ],
    ...over,
  });
  const tidyOf = (over: Partial<MemoryTidy> = {}): MemoryTidy => ({ runs: [run()], auto: false, onAuto: vi.fn(), run: vi.fn(async () => null), undo: vi.fn(async () => undefined), ...over });

  it('自动整理 is a switch; the latest tidy says when and what it changed, each change with 撤销, and 全部撤销', () => {
    const tidy = tidyOf();
    // the notes as they are after that tidy (what it made is there, what it forgot is forgotten)
    setup({ tidy, items: [item(10), item(11), item(4, { status: 'forgotten', tidyId: 7 })] });
    fireEvent.click(screen.getByRole('switch', { name: '自动整理' }));
    expect(tidy.onAuto).toHaveBeenCalledWith(true);
    expect(document.querySelector('.memory-tidy-last')!.textContent).toMatch(/^最近一次：.+ · 4 条改动$/);
    expect([...document.querySelectorAll('.memory-tidy-change')].map((e) => e.textContent)).toEqual([
      '改写：数据处理主要用 Julia（原「数据处理主要用 Python」）撤销',
      '合并：回答简短（原「喜欢简短回答」「回答要短一点」）撤销',
      '已撤销：负责开单系统',
      '删除：周报每周五发撤销',
    ]);
    fireEvent.click(screen.getAllByRole('button', { name: '撤销' })[2]!);
    expect(tidy.undo).toHaveBeenCalledWith(7, 3);
    fireEvent.click(screen.getByRole('button', { name: '全部撤销' }));
    expect(tidy.undo).toHaveBeenCalledWith(7);
  });

  it('立即整理 starts one; while it runs the button says 整理中; a refusal is said; none yet: —', async () => {
    const tidy = tidyOf({ runs: [], run: vi.fn(async () => '还没有配置模型') });
    setup({ tidy });
    expect(document.querySelector('.memory-tidy-last')!.textContent).toBe('最近一次：—');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '立即整理' })));
    expect(tidy.run).toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('还没有配置模型');
    cleanup();
    setup({ tidy: tidyOf({ runs: [run({ status: 'running', changes: [] })] }) });
    expect((screen.getByRole('button', { name: '整理中' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '全部撤销' })).toBeNull();
  });

  it('memory off: neither 自动整理 nor 立即整理 can be used; a failed tidy says so', () => {
    setup({ enabled: false, tidy: tidyOf({ runs: [run({ status: 'failed', changes: [] })] }) });
    expect((screen.getByRole('switch', { name: '自动整理' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '立即整理' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('.memory-tidy-last')!.textContent).toMatch(/· 整理失败$/);
  });
});

describe('设置 › 记忆 › 整理: what can still be undone', () => {
  const change = (action: 'added' | 'forgotten', id: number, over = {}) => ({ action, item: item(id, { text: `第 ${id} 条`, ...over }) });
  const done = (id: number, changes: MemoryTidyRun['changes']): MemoryTidyRun => ({ id, by: 'user', status: 'done', startedAt: '2026-11-12T03:10:00+08:00', sessions: 1, messages: 2, refused: 0, changes });

  it('a later tidy with nothing to change does not hide the changes of the one before', () => {
    const tidy: MemoryTidy = { runs: [done(9, []), done(8, [change('added', 20)])], auto: false, onAuto: vi.fn(), run: vi.fn(async () => null), undo: vi.fn(async () => undefined) };
    setup({ items: [item(20)], tidy });
    expect([...document.querySelectorAll('.memory-tidy-last')].map((e) => e.textContent!.replace(/\d+\/\d+ \d+:\d+/, 'T'))).toEqual(['最近一次：T · 无改动', 'T · 1 条改动']);
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(tidy.undo).toHaveBeenCalledWith(8, 0);
  });

  it('a note deleted below since, or one forgotten that came back: words only, no 撤销, no 全部撤销', () => {
    const run = done(8, [change('added', 20), change('forgotten', 21, { status: 'forgotten', tidyId: 8 })]);
    setup({ items: [item(20, { status: 'forgotten' }), item(21, { status: 'active', tidyId: 8 })], tidy: { runs: [run], auto: false, onAuto: vi.fn(), run: vi.fn(), undo: vi.fn() } });
    expect([...document.querySelectorAll('.memory-tidy-change')].map((e) => e.textContent)).toEqual(['新增：第 20 条', '删除：第 21 条']);
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull();
    expect(screen.queryByRole('button', { name: '全部撤销' })).toBeNull();
  });
});
