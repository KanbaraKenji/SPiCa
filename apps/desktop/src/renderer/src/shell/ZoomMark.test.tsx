// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZOOM_MARK_MS, ZoomMark, type PageZoomBridge } from './ZoomMark';

type Z = { wcId: number; zoom: number; stepped: boolean };

/** A page at `start`; 重置 (reset) brings it to 100% as the main process does: a stepped change. */
function fakeBridge(start = 1) {
  const listeners = new Set<(z: Z) => void>();
  const bridge: PageZoomBridge & { say(z: Z): void } = {
    onZoom: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    zoom: vi.fn(async (wcId: number, how: string) => {
      if (how === 'reset') bridge.say({ wcId, zoom: 1, stepped: true });
      return how === 'get' ? start : 1;
    }),
    say: (z) => act(() => listeners.forEach((l) => l(z))),
  };
  return bridge;
}

const lens = () => screen.queryByRole('button', { name: /缩放/ });
const layer = () => screen.queryByRole('dialog', { name: '缩放' });
const reset = () => screen.queryByRole('button', { name: '重置' });
const said = (c: HTMLElement) => c.querySelector('[aria-live]')?.textContent ?? null;
// The lens's sign: a plus has the upright stroke.
const plus = () => lens()!.querySelector('path')!.getAttribute('d')!.includes('v3.6');
const settle = () => act(async () => {});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ZoomMark', () => {
  it('nothing for a page at 100%', async () => {
    const bridge = fakeBridge();
    const { container } = render(<ZoomMark zoom={bridge} wcId={7} />);
    await settle();
    expect(lens()).toBeNull();
    expect(layer()).toBeNull();
    expect(said(container)).toBe('');
  });

  it('a page already at 125% when shown: the lens with a plus, no layer', async () => {
    const bridge = fakeBridge(1.25);
    render(<ZoomMark zoom={bridge} wcId={7} />);
    await settle();
    expect(lens()?.getAttribute('aria-label')).toBe('缩放 125%');
    expect(plus()).toBe(true);
    expect(layer()).toBeNull();
  });

  it('just after a change: the layer under the lens with the zoom and 重置, gone about 1.5 s after; the lens stays', async () => {
    const bridge = fakeBridge();
    const { container } = render(<ZoomMark zoom={bridge} wcId={7} />);
    await settle();
    bridge.say({ wcId: 7, zoom: 1.25, stepped: true });
    expect(layer()?.textContent).toContain('125%');
    expect(reset()).not.toBeNull();
    expect(said(container)).toBe('缩放 125%');
    act(() => vi.advanceTimersByTime(ZOOM_MARK_MS - 1));
    expect(layer()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(layer()).toBeNull();
    expect(lens()).not.toBeNull();
    expect(said(container)).toBe('');
  });

  it('smaller than 100%: the lens with a minus', async () => {
    const bridge = fakeBridge();
    render(<ZoomMark zoom={bridge} wcId={7} />);
    await settle();
    bridge.say({ wcId: 7, zoom: 0.9, stepped: true });
    expect(plus()).toBe(false);
  });

  it('another change while the layer shows starts the time again', async () => {
    const bridge = fakeBridge();
    render(<ZoomMark zoom={bridge} wcId={7} />);
    await settle();
    bridge.say({ wcId: 7, zoom: 1.1, stepped: true });
    act(() => vi.advanceTimersByTime(1000));
    bridge.say({ wcId: 7, zoom: 1.25, stepped: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(layer()?.textContent).toContain('125%');
    act(() => vi.advanceTimersByTime(ZOOM_MARK_MS - 1000));
    expect(layer()).toBeNull();
  });

  it('Ctrl + 0 (back to 100%): the layer says 100% a moment, then neither it nor the lens', async () => {
    const bridge = fakeBridge(1.5);
    render(<ZoomMark zoom={bridge} wcId={7} />);
    await settle();
    bridge.say({ wcId: 7, zoom: 1, stepped: true });
    expect(layer()?.textContent).toContain('100%');
    expect(lens()).not.toBeNull();
    act(() => vi.advanceTimersByTime(ZOOM_MARK_MS));
    expect(layer()).toBeNull();
    expect(lens()).toBeNull();
  });

  it('the pointer on the layer keeps it; 重置 brings the page back to 100%; it goes after the pointer leaves', async () => {
    const bridge = fakeBridge();
    render(<ZoomMark zoom={bridge} wcId={7} />);
    await settle();
    bridge.say({ wcId: 7, zoom: 1.25, stepped: true });
    fireEvent.pointerEnter(layer()!);
    act(() => vi.advanceTimersByTime(ZOOM_MARK_MS * 2));
    expect(layer()).not.toBeNull();
    fireEvent.click(reset()!);
    expect(bridge.zoom).toHaveBeenCalledWith(7, 'reset');
    expect(layer()?.textContent).toContain('100%');
    fireEvent.pointerLeave(layer()!);
    act(() => vi.advanceTimersByTime(ZOOM_MARK_MS));
    expect(layer()).toBeNull();
    expect(lens()).toBeNull();
  });

  it('the lens pressed opens the layer, which stays, with 重置 focused; Escape closes it back to the lens', async () => {
    const bridge = fakeBridge(1.25);
    render(<ZoomMark zoom={bridge} wcId={7} />);
    await settle();
    fireEvent.click(lens()!);
    expect(lens()?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(reset());
    act(() => vi.advanceTimersByTime(ZOOM_MARK_MS * 3));
    expect(layer()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(layer()).toBeNull();
    expect(document.activeElement).toBe(lens());
  });

  it('opened by hand: a press elsewhere closes it; pressing the lens again closes it too', async () => {
    const bridge = fakeBridge(1.25);
    render(
      <>
        <ZoomMark zoom={bridge} wcId={7} />
        <p>elsewhere</p>
      </>,
    );
    await settle();
    fireEvent.click(lens()!);
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(layer()).toBeNull();
    fireEvent.click(lens()!);
    expect(layer()).not.toBeNull();
    fireEvent.click(lens()!);
    expect(layer()).toBeNull();
  });

  it('a press in the page (the window loses the focus): opened by hand, closed; just after a change, gone the usual time after', async () => {
    const bridge = fakeBridge(1.25);
    render(<ZoomMark zoom={bridge} wcId={7} />);
    await settle();
    fireEvent.click(lens()!);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(layer()).toBeNull();
    bridge.say({ wcId: 7, zoom: 1.5, stepped: true });
    fireEvent.pointerEnter(layer()!);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    act(() => vi.advanceTimersByTime(ZOOM_MARK_MS));
    expect(layer()).toBeNull();
  });

  it('Escape just after a change: closed, the focus left where it was', async () => {
    const bridge = fakeBridge();
    render(
      <>
        <input aria-label="地址" />
        <ZoomMark zoom={bridge} wcId={7} />
      </>,
    );
    await settle();
    const field = screen.getByLabelText('地址');
    field.focus();
    bridge.say({ wcId: 7, zoom: 1.25, stepped: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(layer()).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it('a page that only went somewhere: the lens follows its zoom, no layer; another page: nothing', async () => {
    const bridge = fakeBridge();
    render(<ZoomMark zoom={bridge} wcId={7} />);
    await settle();
    bridge.say({ wcId: 8, zoom: 1.25, stepped: true });
    expect(lens()).toBeNull();
    bridge.say({ wcId: 7, zoom: 1.25, stepped: false });
    expect(lens()).not.toBeNull();
    expect(layer()).toBeNull();
  });

  it('another tab shown: its own zoom, the layer not carried over', async () => {
    const bridge = fakeBridge();
    const { rerender } = render(<ZoomMark zoom={bridge} wcId={7} />);
    await settle();
    bridge.say({ wcId: 7, zoom: 1.25, stepped: true });
    rerender(<ZoomMark zoom={bridge} wcId={9} />);
    await settle();
    expect(layer()).toBeNull();
    expect(lens()).toBeNull();
  });
});
