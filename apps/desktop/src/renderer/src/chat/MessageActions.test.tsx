// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionInfo } from '@spica/protocol';
import { answerText, clipboard, MessageActions } from './MessageActions';
import { Conversation, type ConversationActions } from './Conversation';
import { mailTime } from '../../../shared/mail';
import type { Transcript } from '../store/transcript';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the row under a message', () => {
  it('复制 copies the answer as written (its text parts, Markdown kept), then says 已复制', async () => {
    const write = vi.spyOn(clipboard, 'write').mockResolvedValue();
    const text = answerText([
      { type: 'thinking', text: '想一想' },
      { type: 'text', text: '| 项 | 值 |\n|---|---|\n| a | 1 |' },
      { type: 'tool', callId: 'c', name: 'list_dir', input: {}, state: 'done' },
      { type: 'text', text: '```js\nx()\n```' },
    ]);
    expect(text).toBe('| 项 | 值 |\n|---|---|\n| a | 1 |\n\n```js\nx()\n```');
    render(<MessageActions text={text} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制' })));
    expect(write).toHaveBeenCalledWith(text);
    expect(screen.getByRole('button', { name: '已复制' }).getAttribute('title')).toBe('已复制');
  });

  it('the time in the inbox’s own format', () => {
    const at = '2026-11-11T16:35:00+08:00';
    render(<MessageActions text="x" at={at} />);
    expect(screen.getByText(mailTime(at)).tagName).toBe('TIME');
  });

  it('重新生成: usable on the last round when the core says so; otherwise there but grey, saying why on hover', () => {
    const onRegenerate = vi.fn();
    const { rerender } = render(<MessageActions text="x" regenerate={{ state: { anchorId: 'u1', ok: true }, last: true, onRegenerate }} />);
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    rerender(<MessageActions text="x" regenerate={{ state: { anchorId: 'u1', ok: false, code: 'regenerate.wrote_files', hint: '这一轮修改过文件，无法重新生成。' }, last: true, onRegenerate }} />);
    const off = screen.getByRole('button', { name: '重新生成' });
    expect(off.getAttribute('aria-disabled')).toBe('true');
    expect(off.getAttribute('title')).toBe('这一轮修改过文件，无法重新生成。');
    fireEvent.click(off);
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    rerender(<MessageActions text="x" regenerate={{ state: { anchorId: 'u1', ok: true }, last: false, onRegenerate }} />);
    expect(screen.getByRole('button', { name: '重新生成' }).getAttribute('title')).toBe('这不是最后一轮回答，无法重新生成。');
  });
});

describe('the answers 重新生成 left, in the conversation', () => {
  const session = { id: 's', role: 'top', title: '样机评审', status: 'idle', regenerate: { anchorId: 'u1', ok: true } } as unknown as SessionInfo;
  const transcript = (withNext: boolean): Transcript => ({
    items: [
      { kind: 'user', id: 'u1', text: '帮我整理要点', steer: false },
      {
        kind: 'response',
        id: 'a3',
        blocks: [{ type: 'text', text: '第 2 版' }, { type: 'suggest', callId: 's2', title: '接下来可以', actions: [{ label: '起草邮件', prompt: '起草邮件' }] }],
        interrupted: false,
        messageIds: ['a3'],
        anchorId: 'u1',
        versions: [{ blocks: [{ type: 'text', text: '第 1 版' }, { type: 'suggest', callId: 's1', title: '接下来可以', actions: [{ label: '起草邮件', prompt: '起草邮件' }] }] }],
      },
      ...(withNext ? ([{ kind: 'user', id: 'u2', text: '再短一点', steer: false }] as Transcript['items']) : []),
    ],
  });
  const actions = { send: vi.fn(), regenerate: vi.fn() } as unknown as ConversationActions;

  it('‹ 2 / 2 › flips to the old one: only to look at (no 重新生成, no suggestions); 重新生成 on the newest names its message', () => {
    render(<Conversation session={session} transcript={transcript(false)} actions={actions} />);
    expect(screen.getByText('2 / 2')).toBeTruthy();
    expect(screen.getByText('起草邮件')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '上一版' }));
    expect(screen.getByText('1 / 2')).toBeTruthy();
    expect(screen.getByText('第 1 版')).toBeTruthy();
    expect(screen.queryByText('起草邮件')).toBeNull();
    expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '下一版' }));
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }));
    expect(actions.regenerate).toHaveBeenCalledWith('a3');
  });

  it('a message sent after it: the answer flips back to the newest', () => {
    const { rerender } = render(<Conversation session={session} transcript={transcript(false)} actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: '上一版' }));
    expect(screen.getByText('第 1 版')).toBeTruthy();
    rerender(<Conversation session={session} transcript={transcript(true)} actions={actions} />);
    expect(screen.getByText('第 2 版')).toBeTruthy();
    expect(screen.getByText('2 / 2')).toBeTruthy();
  });
});
