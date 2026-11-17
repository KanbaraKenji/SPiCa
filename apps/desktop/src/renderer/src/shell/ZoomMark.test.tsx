// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZOOM_MARK_MS, ZoomMark, type PageZoomBridge } from './ZoomMark';

type Z = { wcId: number; zoom: number; stepped: boolean };

function fakeBridge() {
  const listeners = new Set<(z: Z) => void>();
  const bridge: PageZoomBridge & { say(z: Z): void } = {
    onZoom: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    zoom: vi.fn(async () => 1),
    say: (z) => act(() => listeners.forEach((l) => l(z))),
  };
  return bridge;
}

const mark = () => screen.queryByRole('button', { name: /重置缩放/ });
const said = (c: HTMLElement) => c.querySelector('[aria-live]')?.textContent ?? null;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ZoomMark', () => {
  it('nothing at first, whatever the page\'s zoom', () => {
    const bridge = fakeBridge();
    const { container } = render(<ZoomMark zoom={bridge} wcId={7} />);
    expect(mark()).toBeNull();
    expect(said(container)).toBe('');
  });

  it('shows the zoom just set, and goes about 1.5 s after; it is not left for a screen reader', () => {
    const bridge = fakeBridge();
    const { container } = render(<ZoomMark zoom={bridge} wcId={7} />);
    bridge.say({ wcId: 7, zoom: 1.25, stepped: true });
    expect(mark()?.textContent).toBe('125%');
    expect(said(container)).toBe('缩放 125%');
    act(() => vi.advanceTimersByTime(ZOOM_MARK_MS - 1));
    expect(mark()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(mark()).toBeNull();
    expect(said(container)).toBe('');
  });

  it('another change while it shows starts the time again', () => {
    const bridge = fakeBridge();
    render(<ZoomMark zoom={bridge} wcId={7} />);
    bridge.say({ wcId: 7, zoom: 1.1, stepped: true });
    act(() => vi.advanceTimersByTime(1000));
    bridge.say({ wcId: 7, zoom: 1.25, stepped: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(mark()?.textContent).toBe('125%');
    act(() => vi.advanceTimersByTime(ZOOM_MARK_MS - 1000));
    expect(mark()).toBeNull();
  });

  it('Ctrl + 0 (back to 100%) shows 100% a moment, then nothing', () => {
    const bridge = fakeBridge();
    render(<ZoomMark zoom={bridge} wcId={7} />);
    bridge.say({ wcId: 7, zoom: 1.5, stepped: true });
    bridge.say({ wcId: 7, zoom: 1, stepped: true });
    expect(mark()?.textContent).toBe('100%');
    act(() => vi.advanceTimersByTime(ZOOM_MARK_MS));
    expect(mark()).toBeNull();
  });

  it('not for another page, nor for a page that only went somewhere or the app\'s zoom', () => {
    const bridge = fakeBridge();
    render(<ZoomMark zoom={bridge} wcId={7} />);
    bridge.say({ wcId: 8, zoom: 1.25, stepped: true });
    bridge.say({ wcId: 7, zoom: 1.25, stepped: false });
    expect(mark()).toBeNull();
  });

  it('pressed while it shows: back to 100%; it stays while the pointer is on it', () => {
    const bridge = fakeBridge();
    render(<ZoomMark zoom={bridge} wcId={7} />);
    bridge.say({ wcId: 7, zoom: 1.25, stepped: true });
    fireEvent.pointerEnter(mark()!);
    act(() => vi.advanceTimersByTime(ZOOM_MARK_MS * 2));
    expect(mark()).not.toBeNull();
    fireEvent.click(mark()!);
    expect(bridge.zoom).toHaveBeenCalledWith(7, 'reset');
    fireEvent.pointerLeave(mark()!);
    act(() => vi.advanceTimersByTime(ZOOM_MARK_MS));
    expect(mark()).toBeNull();
  });

  it('another tab shown: nothing carried over', () => {
    const bridge = fakeBridge();
    const { rerender } = render(<ZoomMark zoom={bridge} wcId={7} />);
    bridge.say({ wcId: 7, zoom: 1.25, stepped: true });
    rerender(<ZoomMark zoom={bridge} wcId={9} />);
    expect(mark()).toBeNull();
  });
});
