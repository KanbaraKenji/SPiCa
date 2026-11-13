// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { MemoryCardMeta, MemoryEntry, MemoryItem, MemoryRefusal, MemoryTidyRun } from '@spica/protocol';
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

const entry = (id: number, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  owner: 'user',
  name: `条目 ${id}`,
  summary: `摘要 ${id}`,
  by: 'assistant',
  createdAt: '2026-11-10T07:59:00+08:00',
  updatedAt: '2026-11-10T07:59:00+08:00',
  ...over,
});

/** A fresh api whose calls are spies. */
const apiOf = (over: Partial<MemoryProps['api']> = {}): MemoryProps['api'] => ({
  add: vi.fn(async () => undefined),
  edit: vi.fn(async () => undefined),
  editEntry: vi.fn(async () => undefined),
  forget: vi.fn(async () => undefined),
  deleteEntry: vi.fn(async () => undefined),
  clear: vi.fn(async () => undefined),
  ...over,
});

function setup(over: Partial<MemoryProps> = {}) {
  const props: MemoryProps = {
    items: [item(1), item(2, { status: 'replaced' }), item(3), item(4, { sessionId: 'ses_gone' }), item(5, { by: 'user', sessionId: undefined, quote: '第 5 条' })],
    entries: [],
    enabled: true,
    onEnabled: vi.fn(),
    api: apiOf(),
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
    setup({ api: apiOf({ edit }) });
    fireEvent.click(within(rowOf('第 3 条')).getByRole('button', { name: '编辑' }));
    const box = screen.getByRole('textbox', { name: '详情' }) as HTMLTextAreaElement;
    expect(box.value).toBe('第 3 条');
    // the facts stay under the box (the user's words while rewording)
    expect(facts()).toContain('原话=原话 3');
    fireEvent.change(box, { target: { value: '邮箱密码是 hunter2' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存' })));
    expect(edit).toHaveBeenCalledWith(3, '邮箱密码是 hunter2');
    expect(screen.getByRole('alert').textContent).toBe('疑似密码、密钥或证件号码，未保存');
    await esc();
    expect(screen.queryByRole('textbox', { name: '详情' })).toBeNull();
    expect(page()!.querySelector('.memory-detail-text')!.textContent).toBe('第 3 条');
  });

  it('saved on its page: the page shows the note again, not the box', async () => {
    const edit = vi.fn(async () => ({ action: 'edited' as const, item: item(3, { text: '新的' }) }));
    setup({ api: apiOf({ edit }) });
    openRow('第 3 条');
    fireEvent.click(within(page()!).getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByRole('textbox', { name: '详情' }), { target: { value: '新的' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存' })));
    expect(screen.queryByRole('textbox', { name: '详情' })).toBeNull();
    expect(page()).toBeTruthy();
  });

  it('添加 makes an entry: 名字, 摘要, 类别 and its first 详情; saved or Esc, back to the list', async () => {
    const add = vi.fn(async (): Promise<MemoryCardMeta | MemoryRefusal> => ({ refused: 'name_taken', field: 'name' }));
    setup({ api: apiOf({ add }) });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(page()!.querySelector('.memory-back')!.textContent).toBe('记忆');
    const save = () => screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: '名字' }), { target: { value: '周报' } });
    fireEvent.change(screen.getByRole('textbox', { name: '摘要' }), { target: { value: '每周五发给王经理' } });
    // a new entry needs its first detail
    expect(save().disabled).toBe(true);
    const box = screen.getByRole('textbox', { name: '详情' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '长'.repeat(MEMORY_CHARS + 1) } });
    expect(screen.getByRole('alert').textContent).toBe(`超过 ${MEMORY_CHARS} 字，未保存`);
    fireEvent.change(box, { target: { value: '周报每周五下午发' } });
    fireEvent.click(screen.getByRole('radio', { name: '领域' }));
    await act(async () => fireEvent.click(save()));
    expect(add).toHaveBeenCalledWith('周报每周五下午发', { name: '周报', summary: '每周五发给王经理', category: 'areas' });
    expect(screen.getByRole('alert').textContent).toBe('名字已被使用，未保存');
    add.mockResolvedValueOnce({ action: 'saved', item: item(6) } as MemoryCardMeta);
    await act(async () => fireEvent.keyDown(box, { key: 'Enter' }));
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

  it('已记住: entries grouped by category in the order 你 领域 主题 人物 项目, each its name and summary; notes in no entry last, without a name', () => {
    setup({
      entries: [entry(1, { name: '王经理', summary: '直属上司', category: 'people' }), entry(2, { name: '回答习惯', summary: '先给结论', category: 'you' }), entry(3, { name: '李老师', summary: '报销审批', category: 'people' }), entry(4, { name: '空的', category: 'areas' })],
      items: [
        item(1, { entryId: 1, text: '王经理是直属上司', updatedAt: '2026-11-12T09:00:00+08:00' }),
        item(2, { text: '一般周三下午不开会' }),
        item(3, { entryId: 2, text: '回答先给结论' }),
        item(4, { entryId: 3, text: '报销找李老师' }),
        item(5, { entryId: 9, text: '条目没了的一条' }),
        item(6, { entryId: 4, text: '删掉的', status: 'forgotten' }),
      ],
    });
    const sections = [...document.querySelectorAll('.memory-known .memory-section')];
    const line = (r: Element) => [r.querySelector('.memory-name')?.textContent ?? null, r.querySelector('.memory-text')!.textContent];
    expect(sections.map((sec) => [sec.querySelector('.memory-cat')?.textContent ?? null, [...sec.querySelectorAll('.memory-row')].map(line)])).toEqual([
      ['你', [['回答习惯', '先给结论']]],
      // newest first: the entry's time is its newest detail's
      ['人物', [['王经理', '直属上司'], ['李老师', '报销审批']]],
      [null, [[null, '条目没了的一条'], [null, '一般周三下午不开会']]],
    ]);
    const boss = [...document.querySelectorAll<HTMLElement>('.memory-row')].find((r) => r.querySelector('.memory-name')?.textContent === '王经理')!;
    expect(boss.querySelector('.memory-open')!.getAttribute('title')).toBe('王经理：直属上司');
    expect(boss.querySelector('.memory-time')!.textContent).toBe(timeOf('2026-11-12T09:00:00+08:00'));
    expect(sections.every((sec) => sec.querySelectorAll('.group-box').length === 1)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '全部清除' }));
    expect(screen.getByText('清除全部 5 条记忆？')).toBeTruthy();
  });

  it("an entry's page: ← 记忆, the name with 编辑 / 删除, 类别, 最后修改, 摘要, 详情 as a list; a detail opens its page (← the entry), and back", async () => {
    const editEntry = vi.fn(async (): Promise<MemoryCardMeta | MemoryRefusal> => ({ refused: 'empty', field: 'summary' }));
    const p = setup({
      entries: [entry(1, { name: '王经理', summary: '直属上司，周报发给他', category: 'people' })],
      items: [item(1, { entryId: 1, text: '王经理是直属上司' }), item(2, { entryId: 1, text: '周报发给王经理' })],
      api: apiOf({ editEntry }),
    });
    fireEvent.click(document.querySelector('.memory-row .memory-open')!);
    const at = page()!;
    expect(at.querySelector('.memory-back')!.textContent).toBe('记忆');
    expect(at.querySelector('.memory-detail-text')!.textContent).toBe('王经理');
    expect(facts().slice(0, 3)).toEqual(['类别=人物', `最后修改=${fullTime(AT)}`, '摘要=直属上司，周报发给他']);
    expect([...at.querySelectorAll('.memory-details li')].map((li) => li.textContent)).toEqual(['王经理是直属上司', '周报发给王经理']);
    // a detail: its own page, back to the entry with that line focused
    fireEvent.click(screen.getByRole('button', { name: '周报发给王经理' }));
    expect(page()!.querySelector('.memory-back')!.textContent).toBe('王经理');
    expect(page()!.querySelector('.memory-detail-text')!.textContent).toBe('周报发给王经理');
    expect(facts()).toEqual([`最后修改=${fullTime(AT)}`, '出处=周三下午的安排', '原话=原话 2']);
    fireEvent.click(page()!.querySelector('.memory-back')!);
    expect(document.activeElement!.textContent).toBe('周报发给王经理');
    // editing the entry: 名字, 摘要, 类别 picked; a refusal names the box
    fireEvent.click(within(page()!).getAllByRole('button', { name: '编辑' })[0]!);
    expect((screen.getByRole('textbox', { name: '名字' }) as HTMLInputElement).value).toBe('王经理');
    expect(within(screen.getByRole('radiogroup', { name: '类别' })).getByRole('radio', { checked: true }).textContent).toBe('人物');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '领域' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存' })));
    expect(editEntry).toHaveBeenCalledWith(1, { name: '王经理', summary: '直属上司，周报发给他', category: 'areas' });
    expect(screen.getByRole('alert').textContent).toBe('摘要为空，未保存');
    await esc();
    // 添加 under 详情: a detail of this entry
    fireEvent.click(within(page()!).getByRole('button', { name: '添加' }));
    expect(page()!.querySelector('.memory-back')!.textContent).toBe('王经理');
    fireEvent.change(screen.getByRole('textbox', { name: '详情' }), { target: { value: '周报每周五发' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存' })));
    expect(p.api.add).toHaveBeenCalledWith('周报每周五发', 1);
  });

  it('删除 on an entry asks first (its name and how many details), then deletes the whole entry', () => {
    const p = setup({
      entries: [entry(1, { name: '王经理', summary: '直属上司', category: 'people' })],
      items: [item(1, { entryId: 1, text: '王经理是直属上司' }), item(2, { entryId: 1, text: '周报发给王经理' })],
    });
    fireEvent.click(within(document.querySelector<HTMLElement>('.memory-row')!).getByRole('button', { name: '删除' }));
    expect(screen.getByText('删除「王经理」？')).toBeTruthy();
    expect(screen.getByText('2 条详情')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '删除' }));
    expect(p.api.deleteEntry).toHaveBeenCalledWith(1);
    expect(p.api.forget).not.toHaveBeenCalled();
  });

  it('the switch is the setting; off, the list stays', () => {
    const p = setup({ enabled: false });
    fireEvent.click(screen.getByRole('switch', { name: '启用记忆' }));
    expect(p.onEnabled).toHaveBeenCalledWith(true);
    expect(rows()).toHaveLength(4);
  });

  it('empty: 暂无记忆, 添加 still there, no 全部清除', () => {
    setup({ items: [], entries: [] });
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

  it('a tidy that only put old notes into entries: 归入 N 条, each note with its entry, and 全部撤销 takes it back', () => {
    const t = tidyOf({ runs: [run({ changes: [], grouped: [{ item: 2, entry: 1 }, { item: 3, entry: 9 }] })] });
    setup({ tidy: t, entries: [entry(1, { name: '作息', category: 'you' })], items: [item(2, { entryId: 1, text: '一般周三下午不开会' }), item(3, { text: '已经不在条目里' })] });
    expect(document.querySelector('.memory-tidy-last')!.textContent).toContain('归入 2 条');
    expect([...document.querySelectorAll('.memory-tidy-change .memory-text')].map((x) => x.textContent)).toEqual(['归入「作息」：一般周三下午不开会']);
    fireEvent.click(screen.getByRole('button', { name: '全部撤销' }));
    expect(t.undo).toHaveBeenCalledWith(7);
  });

  it('a tidy that only rewrote a summary: 更新摘要 N 个, the entry and its summary, and 全部撤销; changed since: not listed', () => {
    const t = tidyOf({ runs: [run({ changes: [], entries: [{ entry: 1, at: 'T1', before: { name: '报价单', summary: '旧的', updatedAt: 'T0' } }, { entry: 2, at: 'T1', before: { name: '周报', summary: '旧', updatedAt: 'T0' } }, { entry: 3, at: 'T1' }] })] });
    setup({ tidy: t, entries: [entry(1, { name: '报价单', summary: '含税价，抄送王经理', updatedAt: 'T1' }), entry(2, { name: '周报', updatedAt: 'T2' })], items: [item(1, { entryId: 1 }), item(2, { entryId: 2 })] });
    expect(document.querySelector('.memory-tidy-last')!.textContent).toContain('更新摘要 2 个');
    expect([...document.querySelectorAll('.memory-tidy-change .memory-text')].map((x) => x.textContent)).toEqual(['更新摘要「报价单」：含税价，抄送王经理']);
    fireEvent.click(screen.getByRole('button', { name: '全部撤销' }));
    expect(t.undo).toHaveBeenCalledWith(7);
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
