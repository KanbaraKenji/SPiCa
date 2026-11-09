// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from './Composer';

afterEach(cleanup);

function setup(running = false) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  render(<Composer running={running} onSend={onSend} onStop={onStop} sessionKey={`s-${Math.random()}`} />);
  const box = screen.getByRole('textbox', { name: '消息' });
  return { box, onSend, onStop };
}

describe('Composer', () => {
  it('sends on Enter and clears the box', () => {
    const { box, onSend } = setup();
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('你好');
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('does not send while an input method is composing', () => {
    const { box, onSend } = setup();
    fireEvent.change(box, { target: { value: 'nihao' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps Shift+Enter for a new line and ignores blank input', () => {
    const { box, onSend } = setup();
    fireEvent.change(box, { target: { value: '第一行' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '发送' })).toHaveProperty('disabled', true);
  });

  it('shows a stop button while running', () => {
    const { onStop } = setup(true);
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(onStop).toHaveBeenCalled();
  });
});
