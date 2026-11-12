// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Conversation, type ConversationActions } from './Conversation';
import { ASK } from './welcome';

afterEach(cleanup);

const empty = { items: [], run: null } as unknown as Parameters<typeof Conversation>[0]['transcript'];
const actions = {} as ConversationActions;
const thursdayAfternoon = new Date(2026, 10, 12, 15, 0);

describe('the empty page of a new conversation', () => {
  it('greets the user by the name in the settings, the question under it', () => {
    render(<Conversation session={undefined} transcript={empty} actions={actions} welcome={{ name: 'Alex', waiting: 0, now: thursdayAfternoon }} />);
    expect(screen.getByText('下午好，Alex')).toBeTruthy();
    expect(screen.getByText(ASK)).toBeTruthy();
  });

  it('no name: the greeting alone, no comma left hanging', () => {
    render(<Conversation session={undefined} transcript={empty} actions={actions} welcome={{ name: '', waiting: 0, now: thursdayAfternoon }} />);
    expect(screen.getByText('下午好')).toBeTruthy();
    expect(screen.queryByText(/，$/)).toBeNull();
  });

  it('no model yet: 未配置模型 and its button, as before, and no greeting', () => {
    render(<Conversation session={undefined} transcript={empty} actions={actions} needsModel welcome={{ name: 'Alex', waiting: 0, now: thursdayAfternoon }} />);
    expect(screen.getByText('未配置模型')).toBeTruthy();
    expect(screen.getByRole('button', { name: '设置模型' })).toBeTruthy();
    expect(screen.queryByText(/下午好/)).toBeNull();
  });
});
