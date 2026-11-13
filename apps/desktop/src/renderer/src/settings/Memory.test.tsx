// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { MemoryCardMeta, MemoryItem, MemoryRefusal, MemoryTidyRun } from '@spica/protocol';
import { fullTime, timeOf } from '../chat/format';
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

const AT = '2026-11-11T07:59:00+08:00';
const rows = () => [...document.querySelectorAll('.memory-row .memory-text')].map((e) => e.textContent);
const rowOf = (text: string) => [...document.querySelectorAll<HTMLElement>('.memory-row')].find((r) => r.querySelector('.memory-text')!.textContent === text)!;
const openRow = (text: string) => fireEvent.click(rowOf(text).querySelector('.memory-open')!);
const page = () => document.querySelector<HTMLElement>('.memory-detail');
const facts = () => [...document.querySelectorAll('.memory-fact')].map((f) => `${f.querySelector('dt')!.textContent}=${f.querySelector('dd')!.textContent}`);
const esc = () => act(() => void fireEvent.keyDown(window, { key: 'Escape' }));

describe('设置 › 记忆', () => {
  it('a note is one line: the sentence (whole on hover), the time, 编辑 and 删除 as icons without a box; no conversation in the line', () => {
    setup();
    expect(rows()).toEqual(['第 5 条', '第 4 条', '第 3 条', '第 1 条']);
    const row = rowOf('第 3 条');
    expect(row.classList.contains('setting-row')).toBe(true);
    expect(row.querySelector('.memory-open')!.getAttribute('title')).toBe('第 3 条');
    expect(row.querySelector('.memory-time')!.textContent).toBe(timeOf(AT));
    expect(within(row).getByRole('button', { name: '编辑' }).className).toBe('icon-btn');
    expect(within(row).getByRole('button', { name: '删除' }).className).toBe('icon-btn');
    expect(screen.queryByRole('button', { name: '周三下午的安排' })).toBeNull();
  });

  it("a line opens the note's page: ← 记忆, the whole sentence with 编辑 / 删除, when it changed, the conversation and the user's words", () => {
    const p = setup();
    openRow('第 3 条');
    expect(document.querySelector('.memory-page')).toBeNull();
    const at = page()!;
    expect(at.querySelector('.memory-back')!.textContent).toBe('记忆');
    expect(at.querySelector('.memory-detail-text')!.textContent).toBe('第 3 条');
    expect(within(at).getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(within(at).getByRole('button', { name: '删除' })).toBeTruthy();
    expect(facts()).toEqual([`最后修改=${fullTime(AT)}`, '出处=周三下午的安排', '原话=原话 3']);
    fireEvent.click(screen.getByRole('button', { name: '周三下午的安排' }));
    expect(p.onOpenSession).toHaveBeenCalledWith('ses_a', 3);
  });

  it('the page says no conversation when it was deleted, and neither for a note added here', () => {
    setup();
    openRow('第 4 条');
    expect(facts()).toEqual([`最后修改=${fullTime(AT)}`, '原话=原话 4']);
    fireEvent.click(page()!.querySelector('.memory-back')!);
    openRow('第 5 条');
    expect(facts()).toEqual([`最后修改=${fullTime(AT)}`]);
  });

  it('← 记忆 goes back to the list, its line focused', () => {
    setup();
    openRow('第 3 条');
    fireEvent.click(page()!.querySelector('.memory-back')!);
    expect(page()).toBeNull();
    expect(document.activeElement).toBe(rowOf('第 3 条').querySelector('.memory-open'));
  });

  it("the pencil opens the page editing; a refusal stays with its reason; saved, the page shows the new words; Esc cancels the edit, not the page", async () => {
    const edit = vi.fn(async (): Promise<MemoryCardMeta | MemoryRefusal> => ({ refused: 'secret' }));
    setup({ api: { add: vi.fn(), edit, forget: vi.fn(), clear: vi.fn() } });
    fireEvent.click(within(rowOf('第 3 条')).getByRole('button', { name: '编辑' }));
    const box = screen.getByRole('textbox', { name: '记忆内容' }) as HTMLTextAreaElement;
    expect(box.value).toBe('第 3 条');
    // the facts stay under the box (the user's words while rewording)
    expect(facts()).toContain('原话=原话 3');
    fireEvent.change(box, { target: { value: '邮箱密码是 hunter2' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存' })));
    expect(edit).toHaveBeenCalledWith(3, '邮箱密码是 hunter2', undefined);
    expect(screen.getByRole('alert').textContent).toBe('疑似密码、密钥或证件号码，未保存');
    await esc();
    expect(screen.queryByRole('textbox', { name: '记忆内容' })).toBeNull();
    expect(page()!.querySelector('.memory-detail-text')!.textContent).toBe('第 3 条');
  });

  it('saved on its page: the page shows the note again, not the box', async () => {
    const edit = vi.fn(async () => ({ action: 'edited' as const, item: item(3, { text: '新的' }) }));
    setup({ api: { add: vi.fn(), edit, forget: vi.fn(), clear: vi.fn() } });
    openRow('第 3 条');
    fireEvent.click(within(page()!).getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByRole('textbox', { name: '记忆内容' }), { target: { value: '新的' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存' })));
    expect(screen.queryByRole('textbox', { name: '记忆内容' })).toBeNull();
    expect(page()).toBeTruthy();
  });

  it('添加 opens the same kind of page with an empty box; too long cannot be saved; saved or Esc, back to the list', async () => {
    const add = vi.fn(async () => ({ action: 'saved' as const, item: item(6) }));
    setup({ api: { add, edit: vi.fn(), forget: vi.fn(), clear: vi.fn() } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(page()!.querySelector('.memory-back')!.textContent).toBe('记忆');
    const box = screen.getByRole('textbox', { name: '记忆内容' }) as HTMLTextAreaElement;
    expect(box.value).toBe('');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: '长'.repeat(MEMORY_CHARS + 1) } });
    expect(screen.getByRole('alert').textContent).toBe(`超过 ${MEMORY_CHARS} 字，未保存`);
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: '周报每周五下午发' } });
    await act(async () => fireEvent.keyDown(box, { key: 'Enter' }));
    expect(add).toHaveBeenCalledWith('周报每周五下午发', undefined);
    expect(page()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await esc();
    expect(page()).toBeNull();
    expect(rows()).toHaveLength(4);
  });

  it('删除 asks first, from the list or from the page (then back to the list); 全部清除 asks first', () => {
    const p = setup();
    fireEvent.click(within(rowOf('第 4 条')).getByRole('button', { name: '删除' }));
    expect(screen.getByText('删除这条记忆？')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '删除' }));
    expect(p.api.forget).toHaveBeenCalledWith(4);
    openRow('第 3 条');
    fireEvent.click(within(page()!).getByRole('button', { name: '删除' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '删除' }));
    expect(p.api.forget).toHaveBeenCalledWith(3);
    expect(page()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '全部清除' }));
    expect(screen.getByText('清除全部 4 条记忆？')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '全部清除' }));
    expect(p.api.clear).toHaveBeenCalled();
  });

  it('a note gone while its page is open (a tidy merged it, a conversation forgot it): the list', () => {
    const props = setup();
    cleanup();
    const { rerender } = render(<Memory {...props} />);
    openRow('第 3 条');
    rerender(<Memory {...props} items={[item(1), item(3, { status: 'forgotten' })]} />);
    expect(page()).toBeNull();
    expect(rows()).toEqual(['第 1 条']);
  });

  it('grouped by category under its name, in the order 你 领域 主题 人物 项目; an empty one not shown; those without one last, without a name', () => {
    setup({
      items: [
        item(1, { category: 'people', text: '王经理是直属上司' }),
        item(2, { text: '一般周三下午不开会' }),
        item(3, { category: 'you', text: '回答先给结论' }),
        item(4, { category: 'people', text: '报销找李老师' }),
        item(5, { category: 'areas', text: '报价写含税价' }),
      ],
    });
    const sections = [...document.querySelectorAll('.memory-known .memory-section')];
    expect(sections.map((sec) => [sec.querySelector('.memory-cat')?.textContent ?? null, [...sec.querySelectorAll('.memory-text')].map((t) => t.textContent)])).toEqual([
      ['你', ['回答先给结论']],
      ['领域', ['报价写含税价']],
      ['人物', ['报销找李老师', '王经理是直属上司']],
      [null, ['一般周三下午不开会']],
    ]);
    // each its own box
    expect(sections.every((sec) => sec.querySelectorAll('.group-box').length === 1)).toBe(true);
  });

  it("a note's page says its category (none for one from before there were categories); editing picks or changes it", async () => {
    const edit = vi.fn(async () => ({ action: 'edited' as const, item: item(1) }));
    setup({ items: [item(1, { category: 'people', text: '王经理是直属上司' }), item(2, { text: '一般周三下午不开会' })], api: { add: vi.fn(), edit, forget: vi.fn(), clear: vi.fn() } });
    openRow('王经理是直属上司');
    expect(facts()[0]).toBe('类别=人物');
    fireEvent.click(within(page()!).getByRole('button', { name: '编辑' }));
    const pick = screen.getByRole('radiogroup', { name: '类别' });
    expect(within(pick).getAllByRole('radio').map((r) => r.textContent)).toEqual(['你', '领域', '主题', '人物', '项目']);
    expect(within(pick).getByRole('radio', { checked: true }).textContent).toBe('人物');
    // the words the same, only the category: 保存 can be pressed
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(pick).getByRole('radio', { name: '项目' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存' })));
    expect(edit).toHaveBeenCalledWith(1, '王经理是直属上司', 'projects');
    fireEvent.click(page()!.querySelector('.memory-back')!);
    openRow('一般周三下午不开会');
    expect(facts().some((f) => f.startsWith('类别='))).toBe(false);
    fireEvent.click(within(page()!).getByRole('button', { name: '编辑' }));
    expect(within(screen.getByRole('radiogroup', { name: '类别' })).queryByRole('radio', { checked: true })).toBeNull();
  });

  it('添加 can pick a category, or leave it', async () => {
    const add = vi.fn(async () => ({ action: 'saved' as const, item: item(6) }));
    setup({ api: { add, edit: vi.fn(), forget: vi.fn(), clear: vi.fn() } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.change(screen.getByRole('textbox', { name: '记忆内容' }), { target: { value: '关注模具交期' } });
    fireEvent.click(screen.getByRole('radio', { name: '主题' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存' })));
    expect(add).toHaveBeenCalledWith('关注模具交期', 'topics');
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
    expect(document.querySelector('.memory-tidy-last')!.textContent).toMatch(/^最近一次.+ · 4 条改动$/);
    expect([...document.querySelectorAll('.memory-tidy-change')].map((e) => e.textContent)).toEqual([
      '改写：数据处理主要用 Julia（原「数据处理主要用 Python」）撤销',
      '合并：回答简短（原「喜欢简短回答」「回答要短一点」）撤销',
      '已撤销：负责开单系统',
      '删除：周报每周五发撤销',
    ]);
    // a change is a settings row with 撤销 as the shared small button at its end
    expect([...document.querySelectorAll('.memory-tidy-change')].every((e) => e.classList.contains('setting-row'))).toBe(true);
    expect(screen.getAllByRole('button', { name: '撤销' }).every((b) => b.className === 'btn btn-small memory-undo')).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: '撤销' })[2]!);
    expect(tidy.undo).toHaveBeenCalledWith(7, 3);
    fireEvent.click(screen.getByRole('button', { name: '全部撤销' }));
    expect(tidy.undo).toHaveBeenCalledWith(7);
  });

  it('立即整理 starts one; while it runs the button says 整理中; a refusal is said; none yet: —', async () => {
    const tidy = tidyOf({ runs: [], run: vi.fn(async () => '还没有配置模型') });
    setup({ tidy });
    expect(document.querySelector('.memory-tidy-last')!.textContent).toBe('最近一次—');
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
    expect(document.querySelector('.memory-tidy-last .settings-hint')!.textContent!.replace(/\d+\/\d+ \d+:\d+/g, 'T')).toBe('T · 无改动T · 1 条改动');
    expect(document.querySelector('.memory-tidy-shown')!.textContent!.replace(/\d+\/\d+ \d+:\d+/, 'T')).toBe('T · 1 条改动');
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
