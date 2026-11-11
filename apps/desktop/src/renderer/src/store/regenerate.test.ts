import { describe, expect, it } from 'vitest';
import type { CoreEvent, Message } from '@spica/protocol';
import { applyEvent, fromHistory, type Item } from './transcript';

const msg = (id: string, seq: number, role: 'user' | 'assistant', text: string, extra: Partial<Message> = {}): Message =>
  ({ id, seq, sessionId: 's', role, kind: role === 'user' ? 'user' : 'assistant', content: [{ type: 'text', text }], createdAt: `2026-11-11T16:${String(30 + seq).padStart(2, '0')}:00+08:00`, ...extra }) as Message;

const response = (items: Item[]) => items.find((i): i is Extract<Item, { kind: 'response' }> => i.kind === 'response');

describe('answers replaced by 重新生成', () => {
  it('from history: the newest answer shows; the replaced ones hang on it, oldest first, each with its own time', () => {
    const t = fromHistory([
      msg('u1', 1, 'user', '帮我整理要点'),
      msg('a1', 2, 'assistant', '第 1 版', { superseded: { of: 'u1', version: 1, at: '2026-11-11T16:40:00+08:00' } }),
      msg('a2', 3, 'assistant', '第 2 版', { superseded: { of: 'u1', version: 2, at: '2026-11-11T16:41:00+08:00' } }),
      msg('a3', 4, 'assistant', '第 3 版'),
    ]);
    expect(t.items.map((i) => i.kind)).toEqual(['user', 'response']);
    const r = response(t.items)!;
    expect(r.blocks).toEqual([{ type: 'text', text: '第 3 版' }]);
    expect(r.messageIds).toEqual(['a3']);
    expect(r.anchorId).toBe('u1');
    expect(r.versions).toEqual([
      { blocks: [{ type: 'text', text: '第 1 版' }], at: '2026-11-11T16:32:00+08:00' },
      { blocks: [{ type: 'text', text: '第 2 版' }], at: '2026-11-11T16:33:00+08:00' },
    ]);
    expect(t.items[0]).toMatchObject({ kind: 'user', at: '2026-11-11T16:31:00+08:00' });
  });

  it('the new answer not written yet: an empty newest answer still carries the old ones', () => {
    const t = fromHistory([msg('u1', 1, 'user', '帮我整理要点'), msg('a1', 2, 'assistant', '第 1 版', { superseded: { of: 'u1', version: 1, at: '' } })]);
    const r = response(t.items)!;
    expect(r.blocks).toEqual([]);
    expect(r.versions?.map((v) => v.blocks)).toEqual([[{ type: 'text', text: '第 1 版' }]]);
  });

  it('live: the answer moves into the old ones and the new text is written in a fresh answer after the message', () => {
    let t = fromHistory([msg('u1', 1, 'user', '帮我整理要点'), msg('a1', 2, 'assistant', '第 1 版')]);
    const ev = (e: Record<string, unknown>, seq: number) => ({ ...e, seq, at: '', sessionId: 's', parentChain: [] }) as unknown as CoreEvent;
    t = applyEvent(t, ev({ type: 'messages.superseded', anchorId: 'u1', messageIds: ['a1'], version: 1 }, 10));
    t = applyEvent(t, ev({ type: 'text.delta', delta: '第 2 版' }, 11));
    expect(t.items.map((i) => i.kind)).toEqual(['user', 'response']);
    const r = response(t.items)!;
    expect(r.blocks).toEqual([{ type: 'text', text: '第 2 版' }]);
    expect(r.versions?.map((v) => v.blocks)).toEqual([[{ type: 'text', text: '第 1 版' }]]);
    expect(r.anchorId).toBe('u1');
  });
});
