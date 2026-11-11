// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CoreEvent, MemoryCardMeta, MemoryItem, Message, SessionInfo } from '@spica/protocol';
import { applyEvent, fromHistory, memoryLine, type Transcript } from '../store/transcript';
import { Conversation, type ConversationActions } from './Conversation';

afterEach(cleanup);

const at = '2026-11-11T08:00:00+08:00';
const item = (id: number, text: string, over: Partial<MemoryItem> = {}): MemoryItem => ({ id, owner: 'user', text, quote: text, status: 'active', by: 'assistant', createdAt: at, updatedAt: at, ...over });
const session: SessionInfo = { id: 's', parentId: null, parentChain: [], role: 'top', title: null, status: 'idle', providerId: 'p', model: 'm', cwd: '', costUsd: 0, createdAt: at, updatedAt: at };

describe('the 已记住 line', () => {
  const saved: MemoryCardMeta = { action: 'saved', item: item(1, '回答简短，先给结论') };
  const replaced: MemoryCardMeta = { action: 'replaced', item: item(3, '数据处理主要用 Julia', { replaces: 2 }), previous: item(2, '数据处理主要用 Python', { status: 'replaced' }) };
  const forgotten: MemoryCardMeta = { action: 'forgotten', item: item(4, '报告一律 A4 竖版', { status: 'forgotten' }) };

  it('says what changed, with 撤销 while the change stands', () => {
    expect(memoryLine(saved, item(1, 'x'))).toEqual({ text: '已记住：回答简短，先给结论', undo: true });
    expect(memoryLine(replaced, item(3, 'x'))).toEqual({ text: '已更新：数据处理主要用 Julia（替换「数据处理主要用 Python」）', undo: true });
    expect(memoryLine(forgotten, item(4, 'x', { status: 'forgotten' }))).toEqual({ text: '已忘记：报告一律 A4 竖版', undo: true });
  });

  it('已撤销 once undone; a change deleted or replaced in the settings keeps only its words', () => {
    expect(memoryLine(saved, item(1, 'x', { status: 'forgotten', undone: true }))).toEqual({ text: '已撤销：回答简短，先给结论', undo: false });
    expect(memoryLine(forgotten, item(4, 'x'))).toEqual({ text: '已撤销：报告一律 A4 竖版', undo: false });
    expect(memoryLine(saved, item(1, 'x', { status: 'forgotten', by: 'user' }))).toEqual({ text: '已记住：回答简短，先给结论', undo: false });
    expect(memoryLine(replaced, item(3, 'x', { status: 'replaced', replacedBy: 5 }))).toMatchObject({ undo: false });
  });

  it('comes from the event while the answer runs and from the stored results when opened again', () => {
    const live = applyEvent({ items: [] }, { type: 'memory.changed', sessionId: 's', seq: 1, at, parentChain: [], callId: 'c1', card: saved } as CoreEvent);
    expect(live.memoryCards).toEqual({ c1: saved });
    // a change made in the settings is no line
    expect(applyEvent({ items: [] }, { type: 'memory.changed', sessionId: '', seq: 2, at, parentChain: [], card: saved } as CoreEvent).memoryCards).toBeUndefined();
    const messages: Message[] = [
      { id: 'u', sessionId: 's', seq: 1, role: 'user', kind: 'user', content: [{ type: 'text', text: '记住：回答简短' }], createdAt: at },
      { id: 'a', sessionId: 's', seq: 2, role: 'assistant', kind: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'remember', input: {} }], createdAt: at },
      { id: 'r', sessionId: 's', seq: 3, role: 'user', kind: 'tool_results', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'Saved as [1].' }], meta: { author: 'runtime', memoryCards: { c1: saved } }, createdAt: at },
    ];
    expect(fromHistory(messages).memoryCards).toEqual({ c1: saved });
  });

  it('in the conversation: the line in place of the step, none for a refused call, 撤销 undoes', async () => {
    const undo = vi.fn(async () => undefined);
    const transcript: Transcript = {
      items: [
        { kind: 'user', id: 'u', text: '记住：回答简短', steer: false },
        {
          kind: 'response',
          id: 'r',
          blocks: [
            { type: 'tool', callId: 'c0', name: 'remember', input: {}, state: 'error', result: 'Not saved: quote not found' },
            { type: 'tool', callId: 'c1', name: 'remember', input: {}, state: 'done' },
            { type: 'text', text: '好的，记住了。' },
          ],
          interrupted: false,
        },
      ],
      memoryCards: { c1: saved },
    };
    render(<Conversation session={session} transcript={transcript} actions={{ openSession: vi.fn() } as unknown as ConversationActions} memory={{ items: [item(1, 'x')], undo }} />);
    expect(document.querySelectorAll('.memory-note')).toHaveLength(1);
    expect(screen.getByText(/已记住：回答简短，先给结论/)).toBeTruthy();
    expect(document.querySelector('.fold-head')).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '撤销' })));
    expect(undo).toHaveBeenCalledWith(1);
  });
});
