// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { openLayers, useEscape } from './escape';
import { ContextMenu } from './ContextMenu';
import { Composer } from '../chat/Composer';

afterEach(cleanup);

function Layer({ name, onClose }: { name: string; onClose: () => void }) {
  useEscape(true, onClose);
  return <div>{name}</div>;
}

/** A slid-out panel and, opened after it, a menu; both close on Esc. */
function Page() {
  const [panel, setPanel] = useState(true);
  const [menu, setMenu] = useState(true);
  return (
    <>
      {panel ? <Layer name="panel" onClose={() => setPanel(false)} /> : null}
      {menu ? <Layer name="menu" onClose={() => setMenu(false)} /> : null}
    </>
  );
}

describe('Esc closes the topmost layer first', () => {
  it('one layer a press, the one opened last first; then Esc goes on to the page', () => {
    const page = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    window.addEventListener('keydown', page);
    render(<Page />);
    expect(openLayers()).toBe(2);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByText('menu')).toBeNull();
    expect(screen.getByText('panel')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByText('panel')).toBeNull();
    expect(page).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(page).toHaveBeenCalledTimes(1);
    expect(page.mock.results[0]!.value).toBe(false);
    window.removeEventListener('keydown', page);
  });

  it('while typing in an input method, Esc is the input method’s', () => {
    const close = vi.fn();
    render(<Layer name="menu" onClose={close} />);
    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true });
    expect(close).not.toHaveBeenCalled();
  });

  it('in the input box while running: a menu or panel open takes the first Esc, the next one stops the run', () => {
    const onStop = vi.fn();
    function Running() {
      const [menu, setMenu] = useState(true);
      return (
        <>
          <Composer running onSend={vi.fn()} onStop={onStop} sessionKey="esc-layers" />
          {menu ? <ContextMenu x={0} y={0} items={[{ label: '重命名', onSelect: vi.fn() }]} onClose={() => setMenu(false)} /> : null}
        </>
      );
    }
    render(<Running />);
    const box = screen.getByRole('textbox', { name: '消息' });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onStop).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('a layer opened later is above one opened before, even when the earlier one was mounted later', async () => {
    function Two() {
      const [late, setLate] = useState(false);
      const [early, setEarly] = useState(false);
      return (
        <>
          {/* rendered first (born first) but opened last */}
          <Toggle name="late" open={late} onClose={() => setLate(false)} />
          {early ? <Layer name="early" onClose={() => setEarly(false)} /> : null}
          <button type="button" onClick={() => setEarly(true)}>
            early
          </button>
          <button type="button" onClick={() => setLate(true)}>
            late
          </button>
        </>
      );
    }
    render(<Two />);
    fireEvent.click(screen.getByRole('button', { name: 'early' }));
    // two presses, one after the other (each its own task)
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByRole('button', { name: 'late' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByText('late', { selector: 'div' })).toBeNull();
    expect(screen.getByText('early', { selector: 'div' })).toBeTruthy();
  });

  it('after Esc the focus goes back to where it was before the press that opened the layer', async () => {
    function Page() {
      const [card, setCard] = useState(false);
      return (
        <>
          <textarea aria-label="消息" />
          <button type="button" onClick={() => setCard(true)}>
            环
          </button>
          {card ? <Layer name="card" onClose={() => setCard(false)} /> : null}
        </>
      );
    }
    render(<Page />);
    const box = screen.getByRole('textbox', { name: '消息' });
    const ring = screen.getByRole('button', { name: '环' });
    box.focus();
    fireEvent.pointerDown(ring);
    ring.focus();
    fireEvent.click(ring);
    expect(screen.getByText('card')).toBeTruthy();
    fireEvent.keyDown(ring, { key: 'Escape' });
    await new Promise((r) => setTimeout(r, 5));
    expect(screen.queryByText('card')).toBeNull();
    expect(document.activeElement).toBe(box);
  });
});

function Toggle({ name, open, onClose }: { name: string; open: boolean; onClose: () => void }) {
  useEscape(open, onClose);
  return open ? <div>{name}</div> : null;
}
