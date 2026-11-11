// @vitest-environment jsdom
// Pictures on the web load by themselves, unless the answer's round brought in outside content (or it is still
// being written): then they wait for a click.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Message, SessionInfo } from '@spica/protocol';
import { webImagesFor } from './answer-image';
import { Conversation, type ConversationActions } from './Conversation';
import { fromHistory, type Transcript } from '../store/transcript';

afterEach(cleanup);

const at = '2026-11-11T20:00:00+08:00';
const picture = '![模具报价参考](https://example.com/mold-quote.png)';

describe('which answers wait for a click', () => {
  it('one whose round brought in outside content, or one still being written', () => {
    const plain = [{ type: 'tool', callId: 'a', name: 'list_dir', input: {}, state: 'done' }, { type: 'text', text: picture }];
    const outside = [{ type: 'tool', callId: 'b', name: 'web_fetch', input: {}, state: 'done', outside: 'web' }, { type: 'text', text: picture }];
    expect(webImagesFor(plain, false)).toBe('auto');
    expect(webImagesFor(plain, true)).toBe('click');
    expect(webImagesFor(outside, false)).toBe('click');
  });

  it('the stored results say which calls brought outside content in (with or without instructions in it)', () => {
    const t = fromHistory([
      { id: 'm1', sessionId: 's', seq: 1, role: 'user', kind: 'user', content: [{ type: 'text', text: '查' }], createdAt: at },
      { id: 'm2', sessionId: 's', seq: 2, role: 'assistant', kind: 'assistant', content: [{ type: 'tool_use', id: 'w', name: 'web_fetch', input: {} }], createdAt: at },
      { id: 'm3', sessionId: 's', seq: 3, role: 'user', kind: 'tool_results', content: [{ type: 'tool_result', toolUseId: 'w', content: 'page' }], meta: { guard: { w: { kind: 'web', source: 'web_fetch', signals: [] } } }, createdAt: at },
    ] as unknown as Message[]);
    const r = t.items[1];
    expect(r?.kind === 'response' && r.blocks[0]).toMatchObject({ outside: 'web' });
    expect(r?.kind === 'response' && r.blocks[0]).not.toHaveProperty('flagged');
  });
});

describe('in the conversation', () => {
  const session = { id: 's', role: 'top', title: '查', status: 'idle' } as unknown as SessionInfo;
  const actions = { send: vi.fn(), openFile: vi.fn(), openFolder: vi.fn(), openSession: vi.fn(), imageUrl: async (p: string) => p } as unknown as ConversationActions;
  const answer = (outside: boolean): Transcript => ({
    items: [
      { kind: 'user', id: 'u1', text: '查', steer: false },
      {
        kind: 'response',
        id: 'a1',
        blocks: [{ type: 'tool', callId: 'w', name: 'web_fetch', input: { url: 'https://example.com' }, state: 'done', ...(outside ? { outside: 'web' as const } : {}) }, { type: 'text', text: picture }],
        interrupted: false,
      },
    ],
  });

  it('after outside content: 显示图片 and the site; a click loads it', async () => {
    await act(async () => {
      render(<Conversation session={session} transcript={answer(true)} actions={actions} />);
    });
    expect(document.querySelector('.md img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /显示图片/ }));
    expect(document.querySelector('.md img')?.getAttribute('src')).toBe('https://example.com/mold-quote.png');
  });

  it('otherwise it shows straight away', async () => {
    await act(async () => {
      render(<Conversation session={session} transcript={answer(false)} actions={actions} />);
    });
    expect(document.querySelector('.md img')?.getAttribute('src')).toBe('https://example.com/mold-quote.png');
  });
});
