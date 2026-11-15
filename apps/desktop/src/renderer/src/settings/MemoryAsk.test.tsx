// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MemoryEntry, MemoryItem, MemoryTidyRun } from '@spica/protocol';
import { Memory, type MemoryProps } from './Memory';
import type { MemoryAsk } from './MemoryAsk';

afterEach(cleanup);

const AT = '2026-11-16T09:00:00+08:00';
const item = (id: number, over: Partial<MemoryItem> = {}): MemoryItem => ({ id, owner: 'user', text: `第 ${id} 条`, quote: '', status: 'active', by: 'assistant', createdAt: AT, updatedAt: AT, ...over });
const entry = (id: number, over: Partial<MemoryEntry> = {}): MemoryEntry => ({ id, owner: 'user', name: `条目 ${id}`, summary: `摘要 ${id}`, by: 'assistant', createdAt: AT, updatedAt: AT, ...over });
const run = (id: number, over: Partial<MemoryTidyRun> = {}): MemoryTidyRun => ({ id, by: 'ask', status: 'done', startedAt: AT, endedAt: AT, sessions: 0, messages: 0, changes: [], refused: 0, ...over });

function askOf(over: Partial<MemoryAsk> = {}): MemoryAsk {
  return { runs: [], send: vi.fn(async () => null), stop: vi.fn(async () => undefined), undo: vi.fn(async () => undefined), ...over };
}

function setup(over: Partial<MemoryProps> = {}) {
  const props: MemoryProps = {
    items: [item(1, { entryId: 10 }), item(2, { entryId: 10 }), item(3, { entryId: 20 }), item(4)],
    entries: [entry(10, { name: '周报' }), entry(20, { name: '王经理' })],
    enabled: true,
    onEnabled: vi.fn(),
    api: { add: vi.fn(), edit: vi.fn(), editEntry: vi.fn(), forget: vi.fn(), deleteEntry: vi.fn(), clear: vi.fn() } as unknown as MemoryProps['api'],
    titleOf: () => undefined,
    onOpenSession: vi.fn(),
    ask: askOf(),
    ...over,
  };
  const view = render(<Memory {...props} />);
  return { props, view };
}

const open = (name: string) => fireEvent.click([...document.querySelectorAll<HTMLElement>('.memory-open')].find((b) => b.textContent!.startsWith(name))!);
const box = () => screen.getByRole('textbox', { name: '要改什么' }) as HTMLInputElement;

describe('设置 › 记忆 › the box at the bottom of a page', () => {
  it("an entry's page ends with the box (要改什么, 发送); a sentence is sent for this entry and the box empties", async () => {
    const ask = askOf();
    setup({ ask });
    open('周报');
    expect(box().placeholder).toBe('要改什么');
    const send = screen.getByRole('button', { name: '发送' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(box(), { target: { value: '摘要改成每周五交' } });
    fireEvent.click(send);
    await waitFor(() => expect(ask.send).toHaveBeenCalledWith({ entry: 10 }, '摘要改成每周五交'));
    await waitFor(() => expect(box().value).toBe(''));
  });

  it('a note in no entry has the box too; a detail in an entry does not, nor a page being edited', () => {
    const ask = askOf();
    setup({ ask });
    open('第 4 条');
    fireEvent.change(box(), { target: { value: '归进周报' } });
    fireEvent.submit(box().closest('form')!);
    expect(ask.send).toHaveBeenCalledWith({ item: 4 }, '归进周报');
    cleanup();
    setup({ ask: askOf() });
    open('周报');
    fireEvent.click(screen.getByRole('button', { name: '第 1 条' }));
    expect(screen.queryByRole('textbox', { name: '要改什么' })).toBeNull();
    cleanup();
    setup({ ask: askOf() });
    open('周报');
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(screen.queryByRole('textbox', { name: '要改什么' })).toBeNull();
  });

  it('memory off or no model: the box is off and says why; a refusal when sent is said', async () => {
    setup({ enabled: false });
    open('周报');
    expect(box().disabled).toBe(true);
    expect(document.querySelector('.memory-ask-off')!.textContent).toBe('记忆已关闭');
    cleanup();
    setup({ ask: askOf({ noModel: true }) });
    open('周报');
    expect(document.querySelector('.memory-ask-off')!.textContent).toBe('还没有配置模型');
    cleanup();
    setup({ ask: askOf({ send: vi.fn(async () => '记忆正在整理') }) });
    open('周报');
    fireEvent.change(box(), { target: { value: '删掉第一条' } });
    fireEvent.submit(box().closest('form')!);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '记忆正在整理');
    expect(box().value).toBe('删掉第一条');
  });

  it('while it runs: the sentence says 修改中 and 发送 is 停止, which stops it', () => {
    const ask = askOf({ runs: [run(7, { status: 'running', endedAt: undefined, ask: { entry: 10, text: '删掉第一条' } })] });
    setup({ ask });
    open('周报');
    expect(document.querySelector('.memory-ask-said')!.textContent).toContain('修改中');
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(ask.stop).toHaveBeenCalledWith(7);
  });

  it('done: one line per change as 整理 writes them, each with 撤销, and 全部撤销; the model’s words as they are', () => {
    const forgot = item(2, { entryId: 10, status: 'forgotten', tidyId: 8 });
    const done = run(8, {
      ask: { entry: 10, text: '删掉第二条，摘要改一下', reply: '已删除，摘要也改了。' },
      changes: [{ action: 'forgotten', item: forgot, entry: '周报' }],
      entries: [{ entry: 10, at: '2026-11-16T09:05:00+08:00', before: { name: '周报', summary: '摘要 10', updatedAt: AT } }],
    });
    const ask = askOf({ runs: [done] });
    setup({ ask, items: [item(1, { entryId: 10 }), forgot, item(3, { entryId: 20 })], entries: [entry(10, { name: '周报', summary: '每周五交', updatedAt: '2026-11-16T09:05:00+08:00' }), entry(20, { name: '王经理' })] });
    open('周报');
    const result = document.querySelector<HTMLElement>('.memory-ask-result')!;
    expect(result.querySelector('.memory-ask-text')!.textContent).toBe('删掉第二条，摘要改一下');
    expect([...result.querySelectorAll('.memory-tidy-change .memory-text')].map((e) => e.textContent)).toEqual(['删除：第 2 条', '更新摘要「周报」：每周五交']);
    expect(result.querySelector('.memory-ask-reply')!.textContent).toBe('已删除，摘要也改了。');
    fireEvent.click(within(result).getAllByRole('button', { name: '撤销' })[0]!);
    expect(ask.undo).toHaveBeenCalledWith(8, 0);
    fireEvent.click(within(result).getByRole('button', { name: '全部撤销' }));
    expect(ask.undo).toHaveBeenCalledWith(8);
  });

  it('the model could not: its words alone, nothing to undo; nothing at all: 没有改动; failed: the reason', () => {
    setup({ ask: askOf({ runs: [run(9, { ask: { entry: 10, text: '嗯', reply: '没听懂要改什么。' } })] }) });
    open('周报');
    expect(document.querySelector('.memory-ask-reply')!.textContent).toBe('没听懂要改什么。');
    expect(screen.queryByRole('button', { name: '全部撤销' })).toBeNull();
    cleanup();
    setup({ ask: askOf({ runs: [run(9, { ask: { entry: 10, text: '嗯' }, refused: 2 })] }) });
    open('周报');
    expect(document.querySelector('.memory-ask-reply')!.textContent).toBe('没有改动');
    cleanup();
    setup({ ask: askOf({ runs: [run(9, { status: 'failed', ask: { entry: 10, text: '嗯' }, error: '已达花费上限' })] }) });
    open('周报');
    expect(document.querySelector('.memory-ask-result .provider-result')!.textContent).toBe('已达花费上限');
  });

  it('a detail moved: 移到 on the page it left and on the entry it went to; a note put in one: 归入', () => {
    const moved = run(11, { ask: { entry: 10, text: '第二条移到王经理' }, grouped: [{ item: 2, entry: 20, from: 10 }] });
    setup({ ask: askOf({ runs: [moved] }), items: [item(1, { entryId: 10 }), item(2, { entryId: 20 }), item(3, { entryId: 20 })] });
    open('周报');
    expect(document.querySelector('.memory-ask-result .memory-text')!.textContent).toBe('移到「王经理」：第 2 条');
    fireEvent.click(screen.getByRole('button', { name: '记忆' }));
    open('王经理');
    expect(document.querySelector('.memory-ask-result .memory-text')!.textContent).toBe('移到「王经理」：第 2 条');
  });
});

describe('设置 › 记忆 › a sentence that empties its page', () => {
  const before = { items: [item(1, { entryId: 10 }), item(3, { entryId: 20 }), item(4)], entries: [entry(10, { name: '周报' }), entry(20, { name: '王经理' })] };

  it('the last detail moved to another entry: that entry’s page, with the result', async () => {
    const ask = askOf();
    const { props, view } = setup({ ask, ...before });
    open('周报');
    fireEvent.change(box(), { target: { value: '移到王经理' } });
    fireEvent.submit(box().closest('form')!);
    await waitFor(() => expect(ask.send).toHaveBeenCalled());
    const done = run(12, { ask: { entry: 10, text: '移到王经理' }, grouped: [{ item: 1, entry: 20, from: 10 }] });
    view.rerender(<Memory {...props} items={[item(1, { entryId: 20 }), item(3, { entryId: 20 }), item(4)]} ask={{ ...ask, runs: [done] }} />);
    expect(screen.getByRole('heading', { name: '王经理' })).toBeTruthy();
    expect(document.querySelector('.memory-ask-result .memory-text')!.textContent).toBe('移到「王经理」：第 1 条');
  });

  it('a note put in an entry: that entry’s page; the last detail deleted: the list, with the result above 已记住', async () => {
    const ask = askOf();
    const { props, view } = setup({ ask, ...before });
    open('第 4 条');
    fireEvent.change(box(), { target: { value: '归进周报' } });
    fireEvent.submit(box().closest('form')!);
    await waitFor(() => expect(ask.send).toHaveBeenCalled());
    view.rerender(<Memory {...props} items={[item(1, { entryId: 10 }), item(3, { entryId: 20 }), item(4, { entryId: 10 })]} ask={{ ...ask, runs: [run(13, { ask: { item: 4, text: '归进周报' }, grouped: [{ item: 4, entry: 10 }] })] }} />);
    expect(screen.getByRole('heading', { name: '周报' })).toBeTruthy();
    expect(document.querySelector('.memory-ask-result .memory-text')!.textContent).toBe('归入「周报」：第 4 条');
    cleanup();

    const ask2 = askOf();
    const s2 = setup({ ask: ask2, ...before });
    open('周报');
    fireEvent.change(box(), { target: { value: '删掉' } });
    fireEvent.submit(box().closest('form')!);
    await waitFor(() => expect(ask2.send).toHaveBeenCalled());
    const forgot = item(1, { entryId: 10, status: 'forgotten', tidyId: 14 });
    s2.view.rerender(<Memory {...s2.props} items={[forgot, item(3, { entryId: 20 }), item(4)]} ask={{ ...ask2, runs: [run(14, { ask: { entry: 10, text: '删掉' }, changes: [{ action: 'forgotten', item: forgot, entry: '周报' }] })] }} />);
    expect(screen.getByText('已记住')).toBeTruthy();
    const left = document.querySelector<HTMLElement>('.memory-ask-left')!;
    expect(left.querySelector('.memory-text')!.textContent).toBe('删除：第 1 条');
    // leaving the list's place forgets it
    open('王经理');
    fireEvent.click(screen.getByRole('button', { name: '记忆' }));
    expect(document.querySelector('.memory-ask-left')).toBeNull();
  });
});
