// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectInfo, SessionInfo } from '@spica/protocol';
import { DetailPanel } from '../shell/DetailPanel';
import { Conversation, type ConversationActions } from './Conversation';
import { clipboard } from './MessageActions';

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

describe('a message sent while the agent works (补充)', () => {
  it('is a bubble as any of yours, with a muted + before its words: read as 补充, not a button, not copied', async () => {
    const write = vi.spyOn(clipboard, 'write').mockResolvedValue();
    render(
      <Conversation
        session={session({ id: 's' })}
        transcript={{ items: [{ kind: 'user', id: 'u1', text: '按新规格整理', steer: false }, { kind: 'user', id: 'u2', text: '规格模板在这', steer: true }] }}
        actions={{} as unknown as ConversationActions}
      />,
    );
    const [plain, steer] = [...document.querySelectorAll('.turn-user')];
    // the same bubble: no other class, no tag line, no dashed box
    expect([plain!.className, steer!.className]).toEqual(['turn-user', 'turn-user']);
    expect(document.querySelector('.turn-user-tag, .is-steer')).toBeNull();
    expect(plain!.querySelector('.turn-user-steer')).toBeNull();
    const mark = screen.getByRole('img', { name: '补充' });
    expect(steer!.contains(mark)).toBe(true);
    expect(mark.getAttribute('title')).toBe('补充');
    // before the words, in their first line; not something to press or to Tab to
    expect(mark.parentElement?.className).toBe('turn-user-text');
    expect(mark.parentElement?.firstChild).toBe(mark);
    expect(mark.closest('button')).toBeNull();
    expect(mark.hasAttribute('tabindex')).toBe(false);
    // 复制 takes what was written, without the +
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: '复制' })[1]!));
    expect(write).toHaveBeenLastCalledWith('规格模板在这');
    write.mockRestore();
  });
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

  it('its step came to the user after the review: why, on the same row (as on its card); hover the error', () => {
    render(
      <Conversation
        session={session({ id: 'top' })}
        transcript={{ items: [{ kind: 'user', id: 'u', text: '建一个项目', steer: false }], run: { startedAt: Date.now(), status: 'tool' } }}
        actions={{ openSession: vi.fn() } as unknown as ConversationActions}
        waiting={[
          { id: 'w-a', title: '同步评审表', status: 'awaiting_confirm', review: { state: 'returned', model: 'm', reason: '你没提到这个位置' } },
          { id: 'w-b', title: '生成趋势图', status: 'awaiting_confirm', review: { state: 'no_result', model: 'm', failure: 'timeout', detail: 'no answer in time' } },
        ]}
      />,
    );
    expect(screen.getByText('未自动放行：你没提到这个位置')).toBeTruthy();
    expect(screen.getByText('未能自动放行：超时').getAttribute('title')).toBe('no answer in time');
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

  it('工具调用 is one group: its heading (how many in all, opens them beside), under it only the calls running now with their ring', () => {
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
    const toggle = vi.fn();
    // a run going on: the call still running is in 进行中
    render(<DetailPanel {...props} transcript={{ ...transcript, run: { startedAt: 0, status: 'running' } } as never} session={session({ id: 'w', role: 'worker' })} parent={undefined} history={{ open: false, toggle }} />);
    const rows = [...document.querySelectorAll('.detail-list .detail-item')];
    expect(rows.map((r) => r.querySelector('.detail-item-icon svg')?.getAttribute('data-status'))).toEqual(['running']);
    expect(rows[0]!.textContent).toContain('b.docx');
    const more = screen.getByRole('button', { name: /工具调用/ });
    expect(more.textContent).toBe('工具调用4');
    // in the group's heading, not a row of its own at the bottom
    expect(more.closest('.detail-section')?.querySelector('.detail-item')).toBeTruthy();
    fireEvent.click(more);
    expect(toggle).toHaveBeenCalled();
  });

  it('still says what a deeper sub-task belongs to', () => {
    render(<DetailPanel {...props} session={session({ id: 'w2', role: 'worker', parentId: 'w', parentChain: ['w', 'pm'] })} parent={session({ id: 'w', role: 'worker', title: '整理报价' })} project={project} />);
    expect(screen.getByText('所属')).toBeTruthy();
    expect(screen.getByText('整理报价')).toBeTruthy();
  });
});

describe('a question waiting for its answer', () => {
  const ask = (callId: string, question: string, answer?: string) => ({ type: 'ask' as const, callId, question, options: ['只写结论', '按议题逐条写'], ...(answer !== undefined ? { answer } : {}) });

  it('stands above the message box, not in the conversation; several waiting: the oldest first, 1 / n', () => {
    const answer = vi.fn();
    render(
      <Conversation
        session={session({ id: 's', status: 'awaiting_answer' })}
        transcript={{ items: [{ kind: 'user', id: 'u1', text: '起草纪要', steer: false }, { kind: 'response', id: 'r1', blocks: [ask('a0', '用哪个模板？', '新模板'), ask('a1', '纪要按哪种口径写？'), ask('a2', '发给谁？')], interrupted: false }] }}
        actions={{ answer } as unknown as ConversationActions}
      />,
    );
    // the answered one stays in the conversation, in one row
    expect(document.querySelector('.transcript-column .ask-card.is-done .ask-done-answer')?.textContent).toBe('新模板');
    // the waiting ones are not in the conversation; the oldest stands in the input area, above the box
    expect(document.querySelector('.transcript-column .ask-card.is-open')).toBeNull();
    const docked = document.querySelector('.transcript-foot .ask-dock .ask-card.is-open')!;
    expect(docked.querySelector('.ask-head .md')?.textContent).toBe('纪要按哪种口径写？');
    // its height bound by what the conversation's box leaves (measured; 0 in a page with no layout)
    expect((docked.parentElement as HTMLElement).style.getPropertyValue('--ask-room')).toMatch(/^\d+px$/);
    expect(docked.querySelector('.ask-place')?.textContent).toBe('1 / 2');
    expect(docked.parentElement?.nextElementSibling?.classList.contains('composer-wrap')).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /按议题逐条写/ }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    expect(answer).toHaveBeenCalledWith('a1', '按议题逐条写');
  });

  it('one waiting: no 1 / 1', () => {
    render(
      <Conversation
        session={session({ id: 's', status: 'awaiting_answer' })}
        transcript={{ items: [{ kind: 'response', id: 'r1', blocks: [ask('a1', '纪要按哪种口径写？')], interrupted: false }] }}
        actions={{} as unknown as ConversationActions}
      />,
    );
    expect(document.querySelector('.ask-dock .ask-card')).toBeTruthy();
    expect(document.querySelector('.ask-place')).toBeNull();
  });
});

describe('a call that waited on 允许 / 拒绝', () => {
  it('once the cards are gone and the calls are done, no row is left turning (the group and the card are not one key)', () => {
    const tool = (callId: string, state: 'done' | 'pending', command: string) =>
      ({ type: 'tool' as const, callId, name: 'run_command', state, ...(state === 'done' ? { input: { command }, durationMs: 40, preview: 'ok' } : { input: undefined }) });
    const confirm = (callId: string, approved?: boolean) => ({ type: 'confirm' as const, callId, name: 'run_command', input: { command: 'node a.js' }, reason: '', ...(approved !== undefined ? { approved } : {}) });
    const props = { session: session({ id: 's', status: 'idle' }), actions: {} as unknown as ConversationActions };
    // waiting on the second call's card: the first call's card (allowed) between them
    const waiting = {
      items: [{ kind: 'response' as const, id: 'r1', interrupted: false, blocks: [tool('a', 'done', 'node a.js'), confirm('a', true), tool('b', 'pending', ''), confirm('b')] }],
    };
    const { rerender } = render(<Conversation {...props} transcript={waiting} />);
    // the round over: both ran, the cards are gone, the answer written
    const over = {
      items: [{ kind: 'response' as const, id: 'r1', interrupted: false, blocks: [tool('a', 'done', 'node a.js'), tool('b', 'done', 'node b.js'), { type: 'text' as const, text: '都跑完了' }] }],
    };
    rerender(<Conversation {...props} transcript={over} />);
    const heads = [...document.querySelectorAll('.turn-response .fold-head')].map((h) => h.textContent);
    expect(heads).toHaveLength(1);
    expect(heads[0]).not.toMatch(/^Running/);
    expect(document.querySelector('.turn-response .fold-meta svg[class*="status"], .turn-response [title="进行中"]')).toBeNull();
  });
});
