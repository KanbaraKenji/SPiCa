// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ContextBreakdown } from '@spica/protocol';
import { ContextCard, shareText } from './ContextCard';
import { Composer } from './Composer';

afterEach(cleanup);

const DATA: ContextBreakdown = {
  window: 160_000,
  total: 28_200,
  measured: true,
  parts: [
    { key: 'system', tokens: 6_900, estimated: true, children: [{ key: 'system.base', tokens: 4_800 }, { key: 'system.rules', tokens: 2_100 }] },
    { key: 'tools', tokens: 2_900, estimated: true },
    { key: 'messages', tokens: 18_400, estimated: true, children: [{ key: 'messages.user', tokens: 18_400 }, { key: 'messages.images', tokens: 0 }] },
  ],
  outputReserve: 32_000,
  free: 99_800,
};

describe('context card', () => {
  it('shares are one decimal of the window', () => {
    expect(shareText(28_200, 160_000)).toBe('17.6%');
    expect(shareText(32_000, 160_000)).toBe('20.0%');
  });

  it('opens from the header, then each part with parts of its own; empty parts are left out', () => {
    render(<ContextCard data={DATA} />);
    const head = screen.getByRole('button', { name: /上下文占用/ });
    expect(head.textContent).toContain('实测28.2k / 160k (17.6%)');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('工具')).toBeNull();
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('工具')).toBeTruthy();
    expect(screen.getByText('输出预留')).toBeTruthy();
    expect(screen.getByText('空余')).toBeTruthy();
    expect(screen.queryByText('规则')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /系统提示/ }));
    expect(screen.getByText('规则')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /对话/ }));
    expect(screen.getByText('你的消息')).toBeTruthy();
    expect(screen.queryByText('图片')).toBeNull();
  });

  it('without a window: 预估, the count alone, no shares, nothing kept or free', () => {
    render(<ContextCard data={{ ...DATA, window: null, measured: false, free: null, total: 9_800 }} />);
    const head = screen.getByRole('button', { name: /上下文占用/ });
    expect(head.textContent).toContain('预估9.8k');
    if (head.getAttribute('aria-expanded') === 'false') fireEvent.click(head);
    expect(screen.queryByText('输出预留')).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('the ring under the box opens it and asks the core for the parts', async () => {
    const detail = vi.fn(async () => DATA);
    render(<Composer running={false} onSend={vi.fn()} onStop={vi.fn()} sessionKey="ctx" tools={{ context: { tokens: 28_200, window: 160_000, detail } }} />);
    fireEvent.click(screen.getByRole('button', { name: '上下文占用 28.2k / 160k 18%' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '上下文占用' })).toBeTruthy());
    expect(detail).toHaveBeenCalledTimes(1);
    // While the card is open the ring offers no hover bubble (the numbers are on the card).
    expect(screen.getByRole('button', { name: /^上下文占用 / }).getAttribute('data-tip')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
