// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState, type ReactNode } from 'react';
import { useModal } from './useModal';
import { ConfirmDialog } from './Dialog';
import { ContextMenu } from './ContextMenu';

afterEach(cleanup);

function Box({ onClose, children }: { onClose(): void; children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useModal(box, onClose);
  return (
    <div ref={box}>
      <button type="button">a</button>
      {children}
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

  it('a dialog or a menu opened inside it takes the first Esc; the next one closes it', () => {
    const onClose = vi.fn();
    function Settings() {
      const [confirm, setConfirm] = useState(true);
      const [editing, setEditing] = useState(true);
      return (
        <Box onClose={onClose}>
          {editing ? <ContextMenu x={0} y={0} items={[{ label: '重命名', onSelect: vi.fn() }]} onClose={() => setEditing(false)} /> : null}
          {confirm ? <ConfirmDialog title="删除？" confirmLabel="删除" onConfirm={vi.fn()} onCancel={() => setConfirm(false)} /> : null}
        </Box>
      );
    }
    render(<Settings />);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
