// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { MemoryItem } from '@spica/protocol';
import { Memory, MEMORY_CHARS, type MemoryProps } from './Memory';

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
