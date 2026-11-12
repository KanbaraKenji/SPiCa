// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloseAsk, CloseDialog } from './CloseDialog';

afterEach(cleanup);

describe('the close question', () => {
  it('the title, two radio choices (最小化到托盘 selected), 不再提醒 unticked, 确定 the main button with the focus, the × last; nothing explained, no 取消', () => {
    const { container } = render(<CloseDialog onAnswer={() => undefined} />);
    expect(screen.getByRole('dialog', { name: '关闭窗口时要怎么做？' })).toBeTruthy();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.labels?.[0]?.textContent)).toEqual(['最小化到托盘', '退出 Spica']);
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    expect(screen.getByRole('radiogroup', { name: '关闭窗口时要怎么做？' })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: '不再提醒' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['确定', '关闭']);
    const ok = screen.getByRole('button', { name: '确定' });
    expect(ok.className).toContain('btn-primary');
    expect(document.activeElement).toBe(ok);
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    expect(container.querySelector('.dialog-detail')).toBeNull();
  });

  it('while a task runs, one line between the title and the choices says 退出 stops it', () => {
    const { container } = render(<CloseDialog onAnswer={() => undefined} running />);
    const line = screen.getByText('有任务正在运行，退出会中断它。');
    expect(line.nextElementSibling).toBe(container.querySelector('.close-dialog-choices'));
  });

  it('确定 answers the selected choice once, 不再提醒 as ticked', () => {
    const onAnswer = vi.fn();
    render(<CloseDialog onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    expect(onAnswer.mock.calls).toEqual([[{ choice: 'tray', remember: false }]]);
    cleanup();
    const again = vi.fn();
    render(<CloseDialog onAnswer={again} />);
    fireEvent.click(screen.getByRole('radio', { name: '退出 Spica' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '不再提醒' }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    expect(again).toHaveBeenCalledWith({ choice: 'quit', remember: true });
  });

  it('Enter is 确定, also from a radio button or the checkbox', () => {
    const onAnswer = vi.fn();
    render(<CloseDialog onAnswer={onAnswer} />);
    const quit = screen.getByRole('radio', { name: '退出 Spica' });
    fireEvent.click(quit);
    fireEvent.keyDown(quit, { key: 'Enter' });
    expect(onAnswer).toHaveBeenCalledWith({ choice: 'quit', remember: false });
    cleanup();
    const again = vi.fn();
    render(<CloseDialog onAnswer={again} />);
    fireEvent.keyDown(screen.getByRole('checkbox', { name: '不再提醒' }), { key: 'Enter' });
    expect(again).toHaveBeenCalledWith({ choice: 'tray', remember: false });
  });

  it('the × at the top right: no choice, nothing kept even when ticked; Tab reaches it after 确定', () => {
    const onAnswer = vi.fn();
    render(<CloseDialog onAnswer={onAnswer} />);
    const x = screen.getByRole('button', { name: '关闭' });
    expect(x.className).toContain('icon-btn');
    const ok = screen.getByRole('button', { name: '确定' });
    expect(ok.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '不再提醒' }));
    fireEvent.click(x);
    fireEvent.click(ok);
    expect(onAnswer.mock.calls).toEqual([[{ choice: null, remember: false }]]);
  });

  it('Esc or a click outside: no choice (nothing kept even when ticked)', () => {
    const onAnswer = vi.fn();
    render(<CloseDialog onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '不再提醒' }));
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
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    expect(bridge.closeAsk.answer).toHaveBeenCalledWith({ choice: 'tray', remember: false });
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();
    expect(off).toHaveBeenCalled();
  });
});
