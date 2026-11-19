// @vitest-environment jsdom
// 操作电脑's approval card: one card for the programs, allowed with one click; answered, one line that opens.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CoreEvent, Message } from '@spica/protocol';
import { ComputerCard } from './ComputerCard';
import type { ComputerBlock } from '../store/computer-card';
import { applyEvent, fromHistory } from '../store/transcript';

afterEach(cleanup);

const apps: ComputerBlock['apps'] = [
  { name: 'Microsoft Excel', exe: 'C:\\Office\\EXCEL.EXE', tier: 'full' },
  { name: '文件资源管理器', exe: 'C:\\Windows\\explorer.exe', tier: 'full', highRisk: true },
  { name: 'Microsoft Edge', exe: 'C:\\Edge\\msedge.exe', tier: 'view' },
];
const waiting: ComputerBlock = { type: 'computer', callId: 'r1', apps };

describe('ComputerCard', () => {
  it('waiting: 操作 N 个程序, 拒绝 and 始终允许, every program a row with its tag and where it is', () => {
    render(<ComputerCard block={waiting} onDecide={vi.fn()} />);
    expect(document.querySelector('.card-title')?.textContent).toBe('操作 3 个程序');
    expect(screen.getAllByRole('button').map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual(['拒绝', '始终允许', '其他允许方式']);
    const rows = [...document.querySelectorAll('.computer-app')].map((r) => r.textContent);
    expect(rows).toEqual(['Microsoft ExcelC:\\Office\\EXCEL.EXE', '文件资源管理器高风险C:\\Windows\\explorer.exe', 'Microsoft Edge只看C:\\Edge\\msedge.exe']);
  });

  it('始终允许 in one click; 允许一次 from its menu; 拒绝; each sent once', () => {
    const always = vi.fn();
    render(<ComputerCard block={waiting} onDecide={always} />);
    fireEvent.click(screen.getByRole('button', { name: '始终允许' }));
    fireEvent.click(screen.getByRole('button', { name: '始终允许' }));
    expect(always.mock.calls).toEqual([[true, true]]);
    cleanup();
    const once = vi.fn();
    render(<ComputerCard block={waiting} onDecide={once} />);
    fireEvent.click(screen.getByRole('button', { name: '其他允许方式' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '允许一次' }));
    expect(once.mock.calls).toEqual([[true, false]]);
    cleanup();
    const no = vi.fn();
    render(<ComputerCard block={waiting} onDecide={no} />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(no.mock.calls).toEqual([[false, false]]);
  });

  it('answered: one line (已始终允许 / 已允许一次 / 已拒绝 / 已中断); pressing it shows the programs', () => {
    const { rerender } = render(<ComputerCard block={{ ...waiting, approved: true, always: true }} onDecide={vi.fn()} />);
    const line = screen.getByRole('button', { name: /已始终允许 3 个程序/ });
    expect(document.querySelector('.computer-card.is-line')).not.toBeNull();
    expect(document.querySelector('.computer-apps')).toBeNull();
    fireEvent.click(line);
    expect(line.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('.computer-app')).toHaveLength(3);
    rerender(<ComputerCard block={{ ...waiting, approved: true, always: false }} onDecide={vi.fn()} />);
    expect(screen.getByRole('button', { name: /已允许一次 3 个程序/ })).toBeTruthy();
    rerender(<ComputerCard block={{ ...waiting, approved: false }} onDecide={vi.fn()} />);
    expect(screen.getByRole('button', { name: /已拒绝 3 个程序/ })).toBeTruthy();
    rerender(<ComputerCard block={{ ...waiting, cancelled: true }} onDecide={vi.fn()} />);
    expect(document.querySelector('.computer-card.is-stopped')?.textContent).toContain('已中断');
  });
});

describe('the card in the conversation', () => {
  const at = '2026-11-19T08:00:00.000Z';
  const ev = (e: Record<string, unknown>) => ({ seq: 1, at, sessionId: 's', parentChain: [], ...e }) as unknown as CoreEvent;
  const prepared = { apps: [...apps.map((a) => ({ ...a, asked: a.name, state: 'ask' })), { asked: 'notepad', name: '记事本', exe: 'n.exe', tier: 'full', state: 'allowed' }], missing: [], ask: true };
  const cards = (t: { items: { kind: string; blocks?: { type: string }[] }[] }) => t.items.flatMap((i) => i.blocks ?? []).filter((b) => b.type === 'computer' || b.type === 'tool' || b.type === 'confirm');

  it('live: the card (only the programs still to allow), no step row; 始终允许 known from the result', () => {
    let t = applyEvent({ items: [] }, ev({ type: 'tool.call', callId: 'r1', name: 'computer_request_access' }));
    t = applyEvent(t, ev({ type: 'confirm.request', callId: 'r1', name: 'computer_request_access', input: { apps: ['x'], prepared }, reason: 'computer_request_access' }));
    expect(cards(t)).toEqual([{ type: 'computer', callId: 'r1', apps }]);
    t = applyEvent(t, ev({ type: 'confirm.resolved', callId: 'r1', approved: true }));
    t = applyEvent(t, ev({ type: 'tool.start', callId: 'r1', name: 'computer_request_access', input: {} }));
    t = applyEvent(t, ev({ type: 'tool.end', callId: 'r1', name: 'computer_request_access', isError: false, preview: '- Microsoft Excel (C:\\Office\\EXCEL.EXE): approved for every conversation — full control', durationMs: 5 }));
    expect(cards(t)).toEqual([{ type: 'computer', callId: 'r1', apps, approved: true, always: true }]);
  });

  it('live: a preview cut before the words 始终允许 leaves what was clicked (never turned into 允许一次)', () => {
    let t = applyEvent({ items: [] }, ev({ type: 'confirm.request', callId: 'r1', name: 'computer_request_access', input: { prepared }, reason: 'computer_request_access' }));
    t = applyEvent(t, ev({ type: 'confirm.resolved', callId: 'r1', approved: true }));
    t = applyEvent(t, ev({ type: 'tool.end', callId: 'r1', name: 'computer_request_access', isError: false, preview: '- Microsoft Excel (C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE): approved for ev', durationMs: 5 }));
    const card = cards(t)[0] as ComputerBlock;
    expect(card.always).toBeUndefined();
  });

  it('from history: the result says what was allowed; a call that needed no card shows nothing', () => {
    const msg = (seq: number, over: Partial<Message>): Message => ({ id: `m${seq}`, sessionId: 's', seq, role: 'user', kind: 'user', content: [{ type: 'text', text: '' }], createdAt: at, ...over }) as Message;
    const result = [
      '- Microsoft Excel (C:\\Office\\EXCEL.EXE): approved for this conversation — full control',
      '- 文件资源管理器 (C:\\Windows\\explorer.exe): approved for this conversation — full control, high risk',
      '- 记事本 (n.exe): already approved — full control',
    ].join('\n');
    const t = fromHistory([
      msg(1, { content: [{ type: 'text', text: '整理清单' }] }),
      msg(2, { role: 'assistant', kind: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'computer_request_access', input: { apps: ['excel', 'explorer', 'notepad'] } }] }),
      msg(3, { kind: 'tool_results', content: [{ type: 'tool_result', toolUseId: 'r1', content: result }] }),
      msg(4, { role: 'assistant', kind: 'assistant', content: [{ type: 'tool_use', id: 'r2', name: 'computer_request_access', input: { apps: ['notepad'] } }] }),
      msg(5, { kind: 'tool_results', content: [{ type: 'tool_result', toolUseId: 'r2', content: '- 记事本 (n.exe): already approved — full control' }] }),
    ]);
    expect(cards(t)).toEqual([
      {
        type: 'computer',
        callId: 'r1',
        approved: true,
        always: false,
        apps: [
          { name: 'Microsoft Excel', exe: 'C:\\Office\\EXCEL.EXE', tier: 'full' },
          { name: '文件资源管理器', exe: 'C:\\Windows\\explorer.exe', tier: 'full', highRisk: true },
        ],
      },
    ]);
  });

  it('waiting after a restart: the card as asked; declined: 已拒绝 with the names asked for', () => {
    const msg = (seq: number, over: Partial<Message>): Message => ({ id: `m${seq}`, sessionId: 's', seq, role: 'user', kind: 'user', content: [{ type: 'text', text: '' }], createdAt: at, ...over }) as Message;
    const call = msg(2, { role: 'assistant', kind: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'computer_request_access', input: { apps: ['excel'] } }] });
    const waitingNow = fromHistory([call], [{ kind: 'confirm', callId: 'r1', toolName: 'computer_request_access', input: { apps: ['excel'], prepared }, reason: 'computer_request_access', createdAt: at }]);
    expect(cards(waitingNow)).toEqual([{ type: 'computer', callId: 'r1', apps }]);
    const declined = fromHistory([call, msg(3, { kind: 'tool_results', content: [{ type: 'tool_result', toolUseId: 'r1', content: 'The user declined this action. Do not retry it unless the user asks.', isError: true }] })]);
    expect(cards(declined)).toEqual([{ type: 'computer', callId: 'r1', apps: [{ name: 'excel', exe: '', tier: 'full' }], approved: false }]);
  });
});
