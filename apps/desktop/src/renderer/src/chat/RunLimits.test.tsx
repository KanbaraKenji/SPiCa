// @vitest-environment jsdom
// What a conversation says when a run stopped at a limit with the work not done.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SessionInfo } from '@spica/protocol';
import { Conversation, type ConversationActions } from './Conversation';

afterEach(cleanup);

const at = '2026-11-12T10:00:00+08:00';
const session: SessionInfo = { id: 's', parentId: null, parentChain: [], role: 'top', title: null, status: 'idle', providerId: 'p', model: 'm', cwd: 'D:\\工作', costUsd: 0, createdAt: at, updatedAt: at };
const answer = { kind: 'response' as const, id: 'a', blocks: [{ type: 'text' as const, text: '我先看了三个文件。' }], interrupted: false, at };

describe('a run stopped at the turn limit', () => {
  it('says it is not done (before, it looked finished)', () => {
    render(<Conversation session={session} transcript={{ items: [{ kind: 'user', id: 'u', text: '整理', steer: false }, answer], stopped: 'max_turns' }} actions={{} as ConversationActions} />);
    expect(screen.getByText('（已达到轮数上限，还没做完）')).toBeTruthy();
  });

  it('says nothing when the run simply finished', () => {
    render(<Conversation session={session} transcript={{ items: [{ kind: 'user', id: 'u', text: '整理', steer: false }, answer] }} actions={{} as ConversationActions} />);
    expect(screen.queryByText(/轮数上限/)).toBeNull();
  });
});
