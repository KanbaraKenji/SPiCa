// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloseAsk, CloseDialog } from './CloseDialog';

afterEach(cleanup);

describe('the close question', () => {
  it('the title, 记住我的选择 and two choices, nothing explained, no 取消; 最小化到托盘 is the main one and has the focus', () => {
    const { container } = render(<CloseDialog onAnswer={() => undefined} />);
    expect(screen.getByRole('dialog', { name: '关闭窗口时要怎么做？' })).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['退出 Spica', '最小化到托盘']);
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    expect(container.querySelector('.dialog-detail')).toBeNull();
    const tray = screen.getByRole('button', { name: '最小化到托盘' });
    expect(tray.className).toContain('btn-primary');
    expect(document.activeElement).toBe(tray);
    expect((screen.getByRole('checkbox', { name: '记住我的选择' }) as HTMLInputElement).checked).toBe(false);
  });

  it('while a task runs, one line says 退出 stops it', () => {
    render(<CloseDialog onAnswer={() => undefined} running />);
    expect(screen.getByText('有任务正在运行，退出会中断它。')).toBeTruthy();
  });

  it('a choice, with or without 记住我的选择, answers once', () => {
    const onAnswer = vi.fn();
    render(<CloseDialog onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: '最小化到托盘' }));
    fireEvent.click(screen.getByRole('button', { name: '退出 Spica' }));
    expect(onAnswer.mock.calls).toEqual([[{ choice: 'tray', remember: false }]]);
    cleanup();
    const again = vi.fn();
    render(<CloseDialog onAnswer={again} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '记住我的选择' }));
    fireEvent.click(screen.getByRole('button', { name: '退出 Spica' }));
    expect(again).toHaveBeenCalledWith({ choice: 'quit', remember: true });
  });

  it('Esc or a click outside: no choice (nothing kept even when ticked)', () => {
    const onAnswer = vi.fn();
    render(<CloseDialog onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '记住我的选择' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onAnswer).toHaveBeenCalledWith({ choice: null, remember: false });
    cleanup();
    const outside = vi.fn();
    const { container } = render(<CloseDialog onAnswer={outside} />);
    fireEvent.mouseDown(container.querySelector('.scrim')!);
    expect(outside).toHaveBeenCalledWith({ choice: null, remember: false });
  });

  it('shown when the main process asks, gone after the answer, which goes back', () => {
    let ask: (a: { running: boolean }) => void = () => undefined;
    const off = vi.fn();
    const bridge = { closeAsk: { listen: vi.fn((fn: (a: { running: boolean }) => void) => ((ask = fn), off)), answer: vi.fn() } };
    const { unmount } = render(<CloseAsk bridge={bridge} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => ask({ running: true }));
    act(() => ask({ running: false }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText('有任务正在运行，退出会中断它。')).toBeTruthy(); // the open question keeps what it said
    fireEvent.click(screen.getByRole('button', { name: '最小化到托盘' }));
    expect(bridge.closeAsk.answer).toHaveBeenCalledWith({ choice: 'tray', remember: false });
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();
    expect(off).toHaveBeenCalled();
  });
});
