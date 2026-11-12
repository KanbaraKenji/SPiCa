// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MonitorEntry } from '../../../shared/monitor';
import { clipboard } from '../ui/clipboard';
import { filterEntries, MonitorView, sourcesLabel, type MonitorApi } from './MonitorView';

afterEach(cleanup);

const e = (seq: number, over: Partial<MonitorEntry> = {}): MonitorEntry => ({ seq, at: '2026-11-13T02:05:09.123Z', source: 'core', level: 'info', text: `line ${seq}`, ...over });

function setup(entries: MonitorEntry[]) {
  let push: (b: MonitorEntry[]) => void = () => undefined;
  const off = vi.fn();
  const api: MonitorApi = {
    list: vi.fn(async () => entries),
    watch: vi.fn((l) => {
      push = l;
      return off;
    }),
    export: vi.fn(async () => ({ file: 'C:/Users/me/Documents/spica-monitor.log' })),
  };
  const view = render(<MonitorView api={api} showInFolder={vi.fn()} />);
  return { api, off, push: (b: MonitorEntry[]) => act(() => push(b)), view };
}

const texts = () => [...document.querySelectorAll('.monitor-row .monitor-text')].map((n) => n.textContent);

describe('监控台', () => {
  it('lists what is kept, then the new lines; a line that came twice shows once; stops listening when closed', async () => {
    const { push, off, view } = setup([e(1), e(2)]);
    await screen.findByText('line 2');
    push([e(2), e(3)]);
    expect(texts()).toEqual(['line 1', 'line 2', 'line 3']);
    view.unmount();
    expect(off).toHaveBeenCalled();
  });

  it('filters by source, by level and by words', async () => {
    const all = [e(1), e(2, { source: 'request', level: 'warn', text: 'deepseek/deepseek-chat #1 429' }), e(3, { source: 'plugin', level: 'error', text: '[mail] fetch failed' })];
    expect(filterEntries(all, new Set(['request', 'plugin']), 'all', '').map((x) => x.seq)).toEqual([2, 3]);
    expect(filterEntries(all, new Set(['core', 'request', 'plugin']), 'warn', '').map((x) => x.seq)).toEqual([2, 3]);
    expect(filterEntries(all, new Set(['core', 'request', 'plugin']), 'error', '').map((x) => x.seq)).toEqual([3]);
    expect(filterEntries(all, new Set(['core', 'request', 'plugin']), 'all', '429').map((x) => x.seq)).toEqual([2]);
    expect(sourcesLabel(new Set(['core', 'request', 'tool', 'plugin', 'process']))).toBe('全部来源');
    expect(sourcesLabel(new Set(['request']))).toBe('请求');
    setup(all);
    await screen.findByText('line 1');
    fireEvent.click(screen.getByRole('radio', { name: '错误' }));
    expect(texts()).toEqual(['[mail] fetch failed']);
    fireEvent.click(screen.getByRole('radio', { name: '全部' }));
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索' }), { target: { value: '429' } });
    expect(texts()).toEqual(['deepseek/deepseek-chat #1 429']);
  });

  it('shows a model’s or a tool’s output as text, never as HTML or Markdown', async () => {
    const evil = '<img src=x onerror="window.__pwned=1"> **bold** <b>b</b> [a](javascript:alert(1))';
    setup([e(1, { text: evil })]);
    await screen.findByText(evil);
    expect(document.querySelector('.monitor img, .monitor b, .monitor strong, .monitor a')).toBeNull();
    fireEvent.click(document.querySelector('.monitor-row')!);
    expect(document.querySelector('.monitor-detail-text')!.textContent).toBe(evil);
    expect(document.querySelector('.monitor-detail img')).toBeNull();
  });

  it('暂停滚动 stops following and counts what came; 继续 goes on', async () => {
    const { push } = setup([e(1)]);
    await screen.findByText('line 1');
    fireEvent.click(screen.getByRole('button', { name: '暂停滚动' }));
    push([e(2), e(3)]);
    expect(screen.getByRole('button', { name: '继续（2 条新）' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '继续（2 条新）' }));
    expect(screen.getByRole('button', { name: '暂停滚动' })).toBeTruthy();
  });

  it('copies one line, exports what is shown', async () => {
    const write = vi.spyOn(clipboard, 'write').mockResolvedValue();
    const { api } = setup([e(1, { source: 'request', level: 'warn', text: 'deepseek/deepseek-chat #1 429' })]);
    await screen.findByText('deepseek/deepseek-chat #1 429');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制这一行' }));
    });
    expect(write).toHaveBeenCalledWith('2026-11-13T02:05:09.123Z\t请求\t警告\tdeepseek/deepseek-chat #1 429');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '导出…' }));
    });
    expect(vi.mocked(api.export).mock.calls[0]![0]).toBe('2026-11-13T02:05:09.123Z\t请求\t警告\tdeepseek/deepseek-chat #1 429\n');
    expect(screen.getByText('C:/Users/me/Documents/spica-monitor.log')).toBeTruthy();
  });

  it('draws only the rows in sight', async () => {
    const many = Array.from({ length: 3000 }, (_, i) => e(i + 1));
    setup(many);
    await screen.findByText('3,000 条');
    expect(document.querySelectorAll('.monitor-row').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.monitor-row').length).toBeLessThan(200);
  });
});
