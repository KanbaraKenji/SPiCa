// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { useModal } from './useModal';

afterEach(cleanup);

function Box({ onClose, esc }: { onClose(): void; esc?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useModal(box, onClose, undefined, esc === undefined ? {} : { esc });
  return (
    <div ref={box}>
      <button type="button">a</button>
    </div>
  );
}

describe('useModal and Esc', () => {
  it('by default Esc closes it and nothing behind it hears the key', () => {
    const onClose = vi.fn();
    const behind = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    window.addEventListener('keydown', behind);
    render(<Box onClose={onClose} />);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    window.removeEventListener('keydown', behind);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(behind).not.toHaveBeenCalled();
  });

  it('esc: false leaves Esc to the page (the settings dialog: App closes it); Tab still stays inside', () => {
    const onClose = vi.fn();
    const behind = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    window.addEventListener('keydown', behind);
    render(<Box onClose={onClose} esc={false} />);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    window.removeEventListener('keydown', behind);
    expect(onClose).not.toHaveBeenCalled();
    expect(behind).toHaveReturnedWith(false);
  });
});
