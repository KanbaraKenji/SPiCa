// @vitest-environment jsdom
// The core's guard against instructions hidden in outside content (mail, web pages,
// files, plugin results): why a confirmation is asked, and what was ignored.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { CoreEvent, Message, PendingItem } from '@spica/protocol';
import { applyEvent, fromHistory, type Transcript } from '../store/transcript';
import { MailStore } from '../store/mail';
import { ConfirmCard } from './Blocks';
import { Conversation, type ConversationActions } from './Conversation';

afterEach(cleanup);

const at = '2026-11-10T01:00:00+08:00';
const ev = (body: object, seq: number) => ({ ...body, seq, at, sessionId: 's', parentChain: [] }) as unknown as CoreEvent;
const msg = (over: Partial<Message>): Message => ({ id: 'x', seq: 1, sessionId: 's', role: 'user', kind: 'user', content: [], createdAt: at, ...over });

describe('confirmations the guard asks for', () => {
  it('say why in Chinese and never show the English reason', () => {
    for (const [cause, text] of [
      ['untrusted_turn', '处理外部内容后的不可逆操作，需要确认。'],
      ['outside_link', '链接来自外部内容，需要确认。'],
      ['sensitive_file', '将读取密钥类文件，需要确认。'],
    ] as const) {
      render(<ConfirmCard block={{ type: 'confirm', callId: 'c', name: 'web_fetch', input: { url: 'https://example.com/verify' }, reason: 'guard: outside link', cause }} onDecide={vi.fn()} />);
      expect(screen.getByText(text)).toBeTruthy();
      expect(screen.queryByText(/guard/)).toBeNull();
      cleanup();
    }
  });

  it('keep the cause from the live request and from a pending item after a restart', () => {
    const live = applyEvent({ items: [] }, ev({ type: 'confirm.request', callId: 'c1', name: 'send_email', input: {}, reason: 'r', cause: 'untrusted_turn' }, 1));
    const lr = live.items[0];
    expect(lr?.kind === 'response' && lr.blocks[0]?.type === 'confirm' ? lr.blocks[0].cause : '').toBe('untrusted_turn');
    const pending: PendingItem = { kind: 'confirm', callId: 'c2', toolName: 'read_file', input: { path: '.env' }, reason: 'r', cause: 'sensitive_file', createdAt: at };
    const restored = fromHistory([], [pending]);
    const rr = restored.items[0];
    expect(rr?.kind === 'response' && rr.blocks[0]?.type === 'confirm' ? rr.blocks[0].cause : '').toBe('sensitive_file');
  });
});

describe('outside content that carried instructions', () => {
  const call = msg({ id: 'a', role: 'assistant', kind: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'web_fetch', input: { url: 'https://example.com' } }] });
  const result = msg({
    id: 'r',
    seq: 2,
    kind: 'tool_results',
    content: [{ type: 'tool_result', toolUseId: 'w1', content: '页面内容' }],
    meta: { guard: { w1: { kind: 'web', source: 'web_fetch', signals: ['override'] } } },
  });

  it('shows one quiet line under the tool, from history and live', () => {
    const t = fromHistory([call, result]);
    render(<Conversation session={undefined} transcript={t} actions={{} as ConversationActions} />);
    expect(screen.getByText('网页中含有指令，已忽略')).toBeTruthy();
    cleanup();
    let live: Transcript = { items: [] };
    live = applyEvent(live, ev({ type: 'tool.start', callId: 'w2', name: 'read_file', input: { path: 'a.txt' } }, 1));
    live = applyEvent(live, ev({ type: 'guard.flagged', callId: 'w2', note: { kind: 'file', source: 'read_file', signals: ['run_command'] } }, 2));
    live = applyEvent(live, ev({ type: 'tool.end', callId: 'w2', name: 'read_file', isError: false, preview: '…', durationMs: 5 }, 3));
    render(<Conversation session={undefined} transcript={live} actions={{} as ConversationActions} />);
    expect(screen.getByText('文件中含有指令，已忽略')).toBeTruthy();
  });

  it('nothing is said when nothing was found', () => {
    const clean = { ...result, meta: { guard: { w1: { kind: 'web' as const, source: 'web_fetch', signals: [] } } } };
    render(<Conversation session={undefined} transcript={fromHistory([call, clean])} actions={{} as ConversationActions} />);
    expect(screen.queryByText(/夹带了指令/)).toBeNull();
  });

  it('marks the mail handed to a project manager and in the inbox store', () => {
    const handed = msg({
      id: 'm',
      content: [{ type: 'text', text: 'New mail for this project.' }],
      meta: {
        author: 'parent',
        mails: [{ id: 'src:1' }, { id: 'src:2' }],
        untrusted: [
          { kind: 'mail', source: 'mail:src:1', signals: ['exfiltrate'] },
          { kind: 'mail', source: 'mail:src:2', signals: [] },
        ],
      },
    });
    expect(fromHistory([handed]).items[0]).toEqual({ kind: 'mail', id: 'm', mailIds: ['src:1', 'src:2'], flagged: ['src:1'] });

    let listener: (e: CoreEvent) => void = () => {};
    const store = new MailStore({ agent: {} as never, onAgentEvent: (l) => ((listener = l), () => {}) });
    listener(ev({ type: 'guard.flagged', note: { kind: 'mail', source: 'mail:src:9', signals: ['mail_action'] } }, 1));
    listener(ev({ type: 'guard.flagged', note: { kind: 'web', source: 'web_fetch', signals: ['override'] } }, 2));
    expect(store.state.get().flagged).toEqual(['src:9']);
  });
});
