// @vitest-environment jsdom
// What a conversation says when a run stopped at a limit with the work not done.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

describe('an answer cut at the most the model may write at once', () => {
  const user = { kind: 'user' as const, id: 'u', text: '写长一点', steer: false };
  const cut = { ...answer, truncated: true };

  it('says it is not finished; 继续 asks for the rest', () => {
    const send = vi.fn();
    render(<Conversation session={session} transcript={{ items: [user, cut] }} actions={{ send } as unknown as ConversationActions} />);
    expect(screen.getByText('回答到达长度上限，没有写完')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(send).toHaveBeenCalledWith('继续');
  });

  it('not on an older answer, not while it is still being written, not when it finished', () => {
    const { rerender } = render(<Conversation session={session} transcript={{ items: [user, cut, { ...user, id: 'u2' }, { ...answer, id: 'a2' }] }} actions={{} as ConversationActions} />);
    expect(screen.queryByText(/长度上限/)).toBeNull();
    rerender(<Conversation session={{ ...session, status: 'thinking' }} transcript={{ items: [user, cut], run: { startedAt: Date.now(), status: 'thinking' } }} actions={{} as ConversationActions} />);
    expect(screen.queryByText(/长度上限/)).toBeNull();
    rerender(<Conversation session={session} transcript={{ items: [user, answer] }} actions={{} as ConversationActions} />);
    expect(screen.queryByText(/长度上限/)).toBeNull();
  });
});

describe('messages to other agents past the limit', () => {
  it('says the message was not sent and that the count starts over when the user writes', () => {
    render(<Conversation session={session} transcript={{ items: [{ kind: 'user', id: 'u', text: '互发', steer: false }, answer], agentLimit: true }} actions={{} as ConversationActions} />);
    expect(screen.getByText('（代理之间互发的消息已达上限，没有再发；你说一句话后重新计数）')).toBeTruthy();
  });
});

describe('a stop at a 花费上限, or the API out of money', () => {
  it('one line and 模型, which opens 设置 › 模型 at the provider the stop named', () => {
    const openModelSettings = vi.fn();
    const actions = { openModelSettings } as unknown as ConversationActions;
    render(<Conversation session={session} transcript={{ items: [{ kind: 'user', id: 'u', text: '整理', steer: false }, answer], error: '已达花费上限', errorAction: 'models', errorProvider: 'p-1' }} actions={actions} />);
    expect(screen.getByText('已达花费上限')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重置' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '模型' }));
    expect(openModelSettings).toHaveBeenCalledWith('p-1');
  });
});

describe('the same step repeated too often', () => {
  it('asks whether to go on; 继续 is a message (which starts the count again)', () => {
    const send = vi.fn();
    render(<Conversation session={session} transcript={{ items: [{ kind: 'user', id: 'u', text: '整理', steer: false }, answer], stopped: 'repeated', repeatCount: 8 }} actions={{ send } as unknown as ConversationActions} />);
    expect(screen.getByText('同一步重复了 8 次，要继续吗')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(send).toHaveBeenCalledWith('继续');
  });
});

describe('the notices sit just above the input box (RunNotices)', () => {
  it('in the input area at the foot of the scrolling box (not among the messages), stacked: interrupted, repeated, cut answer, then the error nearest the box', () => {
    const { container } = render(
      <Conversation
        session={{ ...session, status: 'interrupted' }}
        transcript={{ items: [{ kind: 'user', id: 'u', text: '整理', steer: false }, { ...answer, truncated: true }], stopped: 'repeated', repeatCount: 8, error: '已达花费上限', errorAction: 'models' }}
        actions={{ openModelSettings: vi.fn() } as unknown as ConversationActions}
      />,
    );
    const bar = container.querySelector('.run-notices')!;
    expect(container.querySelector('.transcript-column')!.contains(bar)).toBe(false);
    expect(bar.parentElement?.className).toBe('transcript-foot');
    expect(container.querySelector('.transcript')!.lastElementChild).toBe(bar.parentElement);
    expect(bar.nextElementSibling?.className).toContain('composer-wrap');
    expect([...bar.querySelectorAll('.run-notice-text')].map((n) => n.textContent)).toEqual(['上次运行已中断', '同一步重复了 8 次，要继续吗', '回答到达长度上限，没有写完', '已达花费上限']);
    expect(bar.querySelector('.run-notice.is-error')?.getAttribute('role')).toBe('alert');
  });

  it('none while a run is going, except the error until the run clears it', () => {
    const { container } = render(
      <Conversation
        session={{ ...session, status: 'interrupted' }}
        transcript={{ items: [{ kind: 'user', id: 'u', text: '整理', steer: false }, { ...answer, truncated: true }], stopped: 'repeated', run: { startedAt: 0, status: 'thinking' } }}
        actions={{} as ConversationActions}
      />,
    );
    expect(container.querySelector('.run-notices')).toBeNull();
  });
});

describe('a download for the app’s Python that failed', () => {
  const user = { kind: 'user' as const, id: 'u', text: '用 pandas 汇总', steer: false };
  const notice = (failure: NonNullable<Parameters<typeof Conversation>[0]['transcript']['installFailure']>, net = vi.fn()) => {
    cleanup();
    render(<Conversation session={session} transcript={{ items: [user, answer], installFailure: failure }} actions={{ openNetworkSettings: net } as unknown as ConversationActions} />);
    const n = document.querySelector('.run-notice.is-error');
    return n ? { text: n.querySelector('.run-notice-text')!.textContent, title: n.querySelector('.run-notice-text')!.getAttribute('title'), button: n.querySelector('button')?.textContent ?? null } : null;
  };

  it('one line above the input box: what failed and where, uv’s own words on hover, 网络 only where the network settings help', () => {
    expect(notice({ reason: 'connect', host: 'pypi.example.com', detail: 'dns error' })).toEqual({ text: '无法连接 pypi.example.com', title: 'dns error', button: '网络' });
    expect(notice({ reason: 'certificate', host: 'releases.astral.sh', detail: 'UnknownIssuer' })).toMatchObject({ text: 'releases.astral.sh 的证书不受信任', button: '网络' });
    expect(notice({ reason: 'proxy', detail: 'tunnel' })).toMatchObject({ text: '无法连接代理', button: '网络' });
    expect(notice({ reason: 'proxy_auth', detail: '407' })).toMatchObject({ text: '代理需要身份验证（HTTP 407）', button: '网络' });
    expect(notice({ reason: 'disk', detail: 'os error 112' })).toMatchObject({ text: '磁盘空间不足', button: null });
    expect(notice({ reason: 'other', host: 'pypi.example.com', detail: 'No solution found' })).toMatchObject({ text: '下载失败', button: null });
    const net = vi.fn();
    notice({ reason: 'connect', host: 'pypi.example.com', detail: 'x' }, net);
    fireEvent.click(screen.getByRole('button', { name: '网络' }));
    expect(net).toHaveBeenCalledTimes(1);
  });
});
