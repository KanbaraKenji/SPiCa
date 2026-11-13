// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FileCardMeta, SessionInfo } from '@spica/protocol';
import { DetailPanel, FILES_SHOWN } from './DetailPanel';
import { ToolHistory } from './ToolHistory';
import type { Transcript } from '../store/transcript';

afterEach(cleanup);

const at = '2026-11-13T10:00:00.000Z';
const session = { id: 's', title: '演示', role: 'top', status: 'idle', parentId: null, parentChain: [], cwd: 'D:\\工作', costUsd: 0, createdAt: at, updatedAt: at } as unknown as SessionInfo;

const card = (path: string): FileCardMeta => ({ path, name: path.split('\\').pop()!, kind: 'text', sizeBytes: 10, modifiedAt: at, extractedAt: at, read: {}, origin: 'created' });

function transcriptWith(files: number): Transcript {
  const blocks = [
    { type: 'tool' as const, callId: 'a', name: 'list_dir', input: { path: '.' }, state: 'done' as const, durationMs: 4000, result: '第1节.md' },
    { type: 'tool' as const, callId: 'b', name: 'run_command', input: { command: 'python 校对.py', description: '校对' }, state: 'error' as const, result: '[EXIT 1] 缺少第 3 列' },
    { type: 'tool' as const, callId: 'c', name: 'run_command', input: { command: 'python 核对.py', description: '核对' }, state: 'running' as const },
    { type: 'tool' as const, callId: 'd', name: 'run_command', input: { command: 'python 导出.py', description: '导出' }, state: 'timeout' as const },
    ...Array.from({ length: files }, (_, i) => ({ type: 'tool' as const, callId: `w${i}`, name: 'write_file', input: { path: `D:\\工作\\输出\\纪要-${i + 1}.md` }, state: 'done' as const, durationMs: 40 })),
  ];
  const fileCards = Object.fromEntries(Array.from({ length: files }, (_, i) => [`w${i}`, card(`D:\\工作\\输出\\纪要-${i + 1}.md`)]));
  return { items: [{ kind: 'response', id: 'r', interrupted: false, blocks }], fileCards } as unknown as Transcript;
}

const props = { globalCostUsd: 0, onOpenFile: vi.fn(), onOpenSession: vi.fn(), session, parent: undefined };

describe('详情 › 文件, as Claude’s Outputs', () => {
  it('five first, then 显示更多 shows them all and turns into 收起; a row is the icon and the name, the path on hover', () => {
    const onPreviewFile = vi.fn();
    render(<DetailPanel {...props} transcript={transcriptWith(8)} onPreviewFile={onPreviewFile} />);
    const names = () => [...document.querySelectorAll('.detail-file-name')].map((n) => n.textContent);
    expect(names()).toHaveLength(FILES_SHOWN);
    const row = document.querySelector('.detail-file') as HTMLElement;
    expect(row.textContent).toBe('纪要-1.md');
    expect(row.getAttribute('title')).toBe('D:\\工作\\输出\\纪要-1.md');
    fireEvent.click(screen.getByRole('button', { name: '显示更多' }));
    expect(names()).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(names()).toHaveLength(FILES_SHOWN);
    fireEvent.click(row);
    expect(onPreviewFile).toHaveBeenCalledWith('D:\\工作\\输出\\纪要-1.md');
  });

  it('the heading folds the list; folded, it says how many', () => {
    render(<DetailPanel {...props} transcript={transcriptWith(3)} />);
    const head = screen.getByRole('button', { name: /文件/ });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(head.querySelector('.detail-count')).toBeNull();
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.querySelector('.detail-count')?.textContent).toBe('3');
    expect(document.querySelector('.detail-file')).toBeNull();
  });

  it('no call running: no 进行中 group at all', () => {
    const t = transcriptWith(1);
    const blocks = (t.items[0] as { blocks: { state: string }[] }).blocks;
    blocks[2]!.state = 'done';
    render(<DetailPanel {...props} transcript={t} history={{ open: false, toggle: vi.fn() }} />);
    expect(screen.queryByText('进行中')).toBeNull();
    expect(screen.getByRole('button', { name: /工具调用/ }).textContent).toBe('工具调用5');
  });
});

describe('工具调用 (the finished calls, where the preview goes)', () => {
  it('lists every finished call in order with how it ended; a click opens its input and result as plain text; Esc closes it', () => {
    const onClose = vi.fn();
    render(<ToolHistory transcript={transcriptWith(1)} onClose={onClose} />);
    const rows = [...document.querySelectorAll('.tool-history-row')];
    // no run going on: the call left running by a stopped run is finished too, 已中断 (red)
    expect(rows.map((r) => r.querySelector('.detail-item-icon svg')?.getAttribute('data-status'))).toEqual(['done', 'error', 'stopped', 'stopped', 'done']);
    expect(rows.map((r) => r.querySelector('.detail-item-meta')?.textContent)).toEqual(['4s', 'Failed', '已中断', '已超时', '<1s']);
    expect(rows[2]!.querySelector('.detail-item-meta .text-danger')?.textContent).toBe('已中断');
    expect(document.querySelector('.tool-history-head')?.textContent).toContain('5');
    cleanup();
    // while the run goes on, the running one is not here (it is in 进行中)
    render(<ToolHistory transcript={{ ...transcriptWith(1), run: { startedAt: 0, status: 'running' } } as never} onClose={onClose} />);
    expect(document.querySelectorAll('.tool-history-row')).toHaveLength(4);
    const live = [...document.querySelectorAll('.tool-history-row')];
    fireEvent.click(live[1]!);
    const texts = [...document.querySelectorAll('.tool-history-text')].map((p) => p.textContent);
    expect(texts[0]).toContain('"command": "python 校对.py"');
    expect(texts[1]).toBe('[EXIT 1] 缺少第 3 列');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.querySelector('.tool-history-body')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭工具调用' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('the result as the conversation shows it: the note only for the model and the fetch line are left out', () => {
    const t = transcriptWith(0);
    (t.items[0] as { blocks: { result?: string }[] }).blocks[0]!.result = ['[fetched at 2026-11-13T10:00:00Z]', '第1节.md'].join('\n');
    render(<ToolHistory transcript={t} onClose={vi.fn()} />);
    fireEvent.click(document.querySelector('.tool-history-row')!);
    expect(document.querySelectorAll('.tool-history-text')[1]!.textContent).toBe('第1节.md');
  });

  it('a result that looks like markup stays text', () => {
    const t = transcriptWith(0);
    (t.items[0] as { blocks: { result?: string }[] }).blocks[0]!.result = '<img src=x onerror=alert(1)> **粗体**';
    render(<ToolHistory transcript={t} onClose={vi.fn()} />);
    fireEvent.click(document.querySelector('.tool-history-row')!);
    expect(document.querySelector('.tool-history-body img')).toBeNull();
    expect(document.querySelectorAll('.tool-history-text')[1]!.textContent).toBe('<img src=x onerror=alert(1)> **粗体**');
  });
});
