// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ConfirmDialog } from './Dialog';
import { NewProjectDialog } from '../shell/NewProjectDialog';
import { useGuard } from './guard';

afterEach(cleanup);

const tab = (shift = false) => fireEvent.keyDown(window, { key: 'Tab', shiftKey: shift });

describe('one submit at a time', () => {
  it('a second call while the first runs is dropped', async () => {
    let finish!: () => void;
    const work = vi.fn(() => new Promise<void>((r) => (finish = r)));
    function Probe() {
      const run = useGuard();
      return (
        <button type="button" onClick={() => void run(work)}>
          go
        </button>
      );
    }
    render(<Probe />);
    const b = screen.getByRole('button', { name: 'go' });
    fireEvent.click(b);
    fireEvent.click(b);
    fireEvent.click(b);
    expect(work).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    fireEvent.click(b);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('a confirm box confirms once, however fast it is clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="删除？" confirmLabel="删除" onConfirm={onConfirm} onCancel={vi.fn()} />);
    const ok = screen.getByRole('button', { name: '删除' });
    fireEvent.click(ok);
    fireEvent.click(ok);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('新项目: 创建 clicked three times creates one project', async () => {
    let finish!: (v: string | null) => void;
    const onCreate = vi.fn(() => new Promise<string | null>((r) => (finish = r)));
    render(<NewProjectDialog onPickFolder={async () => null} onCreate={onCreate} onClose={vi.fn()} initialName="样机评审" />);
    const create = screen.getByRole('button', { name: '创建' });
    fireEvent.click(create);
    fireEvent.click(create);
    fireEvent.click(create);
    expect(onCreate).toHaveBeenCalledTimes(1);
    await act(async () => finish(null));
  });
});

describe('dialogs keep the keyboard', () => {
  function Opener() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          新项目
        </button>
        {open ? <NewProjectDialog onPickFolder={async () => null} onCreate={async () => null} onClose={() => setOpen(false)} /> : null}
      </>
    );
  }

  it('Tab goes round inside, Esc closes, and the focus goes back to what opened it', () => {
    render(<Opener />);
    const opener = screen.getByRole('button', { name: '新项目' });
    opener.focus();
    fireEvent.click(opener);
    const name = screen.getByPlaceholderText('样机评审');
    expect(document.activeElement).toBe(name);
    // Past the last control (创建): back to the first, never to the page behind.
    screen.getByRole('button', { name: '创建' }).focus();
    tab();
    expect(document.activeElement).toBe(name);
    // Shift+Tab from the first: to the last.
    tab(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '创建' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('a confirm box starts on its confirm button and keeps Tab inside', () => {
    render(<ConfirmDialog title="删除？" confirmLabel="删除" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const ok = screen.getByRole('button', { name: '删除' });
    expect(document.activeElement).toBe(ok);
    tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }));
  });
});
