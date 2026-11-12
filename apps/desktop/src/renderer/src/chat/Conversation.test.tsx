// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectInfo, SessionInfo } from '@spica/protocol';
import { DetailPanel } from '../shell/DetailPanel';
import { Conversation, type ConversationActions } from './Conversation';

afterEach(cleanup);

const at = '2026-11-09T10:00:00+08:00';
const session = (over: Partial<SessionInfo>): SessionInfo => ({
  id: 's',
  parentId: null,
  parentChain: [],
  role: 'top',
  title: null,
  status: 'tool',
  providerId: 'p',
  model: 'm',
  cwd: 'D:\\工作\\样机评审',
  costUsd: 0,
  createdAt: at,
  updatedAt: at,
  ...over,
});

describe('a sub-task that waits for the user', () => {
  it('is said under the parent conversation, with a way to go there', () => {
    const openSession = vi.fn();
    render(
      <Conversation
        session={session({ id: 'top' })}
        transcript={{ items: [{ kind: 'user', id: 'u', text: '建一个项目', steer: false }], run: { startedAt: Date.now(), status: 'tool' } }}
        actions={{ openSession } as unknown as ConversationActions}
        waiting={[{ id: 'w-a', title: '子Agent A：总结评审报告 PDF', status: 'awaiting_confirm' }]}
      />,
    );
    expect(screen.getByText('「子Agent A：总结评审报告 PDF」等待确认')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '处理' }));
    expect(openSession).toHaveBeenCalledWith('w-a');
  });
});

describe('opened from a history row or link', () => {
  it('scrolls to the message, marks it, and has a way back to where it was opened from', () => {
    const onBack = vi.fn();
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(
      <Conversation
        session={session({ id: 'old', status: 'idle' })}
        transcript={{
          items: [
            { kind: 'user', id: 'u1', text: '看一下报价单', steer: false },
            { kind: 'response', id: 'r1', blocks: [{ type: 'text', text: '合计 12,800 元' }], interrupted: false },
            { kind: 'user', id: 'u2', text: '好的', steer: false },
          ],
          seqs: { u1: 1, r1: 2, u2: 6 },
        }}
        actions={{ openSession: vi.fn() } as unknown as ConversationActions}
        found={{ seq: 4, back: { title: '我以前问过的那份报价单，合计是多少？', onBack } }}
      />,
    );
    const marked = document.querySelector('[data-found]');
    expect(marked?.textContent).toContain('合计 12,800 元');
    expect(scrolled).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '返回「我以前问过的那份报价单，合计是多少？」' }));
    expect(onBack).toHaveBeenCalled();
  });
});

describe('DetailPanel', () => {
  const project: ProjectInfo = {
    id: 'p',
    name: '验收-样机评审',
    folder: 'K:\\spica-review\\验收资料',
    managerSessionId: 'pm',
    workflowId: null,
    stage: null,
    status: 'active',
    createdAt: at,
    updatedAt: at,
  };
  const props = { transcript: { items: [] }, globalCostUsd: 0, onOpenFile: vi.fn(), onOpenSession: vi.fn() };

  it('names the project once for a sub-task of its manager', () => {
    render(<DetailPanel {...props} session={session({ id: 'w', role: 'worker', parentId: 'pm', parentChain: ['pm'] })} parent={session({ id: 'pm', role: 'manager', title: '验收-样机评审' })} project={project} />);
    expect(screen.getByText('项目')).toBeTruthy();
    expect(screen.queryByText('所属')).toBeNull();
    expect(screen.getAllByText('验收-样机评审')).toHaveLength(1);
  });

  it('the details have no 最大化 (a fixed width); floating, the head says 详情 and has 关闭详情', () => {
    render(<DetailPanel {...props} session={session({ id: 'w', role: 'worker' })} parent={undefined} onClose={vi.fn()} />);
    const head = document.querySelector('.detail-head') as HTMLElement;
    expect(head.querySelector('.detail-heading')?.textContent).toBe('详情');
    expect([...head.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['关闭详情']);
    cleanup();
    // Under a tab row (plugin pages beside it) and docked: no head here.
    render(<DetailPanel {...props} session={session({ id: 'w', role: 'worker' })} parent={undefined} hideHeading />);
    expect(document.querySelector('.detail-head')).toBeNull();
    expect(screen.queryByRole('button', { name: '最大化' })).toBeNull();
  });

  it('its list of tool calls says how each stands in the first place; failed in English; nothing after the name but the time or the words', () => {
    const transcript = {
      items: [
        {
          kind: 'response' as const,
          id: 'r',
          interrupted: false,
          blocks: [
            { type: 'tool' as const, callId: 'a', name: 'list_dir', input: { path: '.' }, state: 'done' as const, durationMs: 4000 },
            { type: 'tool' as const, callId: 'b', name: 'read_file', input: { path: 'a.docx' }, state: 'error' as const },
            { type: 'tool' as const, callId: 'c', name: 'read_file', input: { path: 'b.docx' }, state: 'running' as const },
            { type: 'tool' as const, callId: 'd', name: 'read_file', input: { path: 'c.docx' }, state: 'timeout' as const },
          ],
        },
      ],
    };
    render(<DetailPanel {...props} transcript={transcript} session={session({ id: 'w', role: 'worker' })} parent={undefined} />);
    const rows = [...document.querySelectorAll('.detail-list .detail-item')];
    expect(rows.map((r) => r.querySelector('.detail-item-icon svg')?.getAttribute('data-status'))).toEqual(['done', 'error', 'running', 'stopped']);
    expect(rows.map((r) => r.querySelector('.detail-item-meta')?.textContent)).toEqual(['4s', 'Failed', '', '已超时']);
    expect(rows.map((r) => r.querySelector('.detail-item-main')?.className)).toEqual(Array(4).fill('detail-item-main'));
  });

  it('still says what a deeper sub-task belongs to', () => {
    render(<DetailPanel {...props} session={session({ id: 'w2', role: 'worker', parentId: 'w', parentChain: ['w', 'pm'] })} parent={session({ id: 'w', role: 'worker', title: '整理报价' })} project={project} />);
    expect(screen.getByText('所属')).toBeTruthy();
    expect(screen.getByText('整理报价')).toBeTruthy();
  });
});
