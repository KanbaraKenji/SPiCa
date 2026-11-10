// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { PEEK_CLOSE_MS, PEEK_OPEN_MS, usePeek } from './peek';

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const { result } = renderHook(() => usePeek(onOpen, onClose));
  return { peek: () => result.current, onOpen, onClose };
}

describe('resting on the icon column slides the sidebar out', () => {
  it('opens after a short rest, not on a pass over the column', () => {
    const { peek, onOpen } = setup();
    expect(PEEK_OPEN_MS).toBeLessThanOrEqual(120);
    act(() => peek().openSoon(false));
    act(() => vi.advanceTimersByTime(PEEK_OPEN_MS - 1));
    expect(onOpen).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onOpen).toHaveBeenCalledTimes(1);
    // Passing over: the pointer leaves before the wait is over.
    act(() => peek().openSoon(false));
    act(() => peek().cancel());
    act(() => vi.advanceTimersByTime(PEEK_OPEN_MS));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('goes back a little later than it came, and the next rest opens it again', () => {
    const { peek, onOpen, onClose } = setup();
    act(() => peek().openSoon(false));
    act(() => vi.advanceTimersByTime(PEEK_OPEN_MS));
    act(() => peek().closeSoon(true));
    act(() => vi.advanceTimersByTime(PEEK_CLOSE_MS - 1));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Was: the finished close wait was kept, and every later rest did nothing until the pointer left the column.
    act(() => peek().openSoon(false));
    act(() => vi.advanceTimersByTime(PEEK_OPEN_MS));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('coming back before it goes keeps it out; one opened on purpose does not go by itself', () => {
    const { peek, onClose } = setup();
    act(() => peek().closeSoon(true));
    act(() => peek().cancel());
    act(() => vi.advanceTimersByTime(PEEK_CLOSE_MS));
    expect(onClose).not.toHaveBeenCalled();
    act(() => peek().closeSoon(false));
    act(() => vi.advanceTimersByTime(PEEK_CLOSE_MS));
    expect(onClose).not.toHaveBeenCalled();
  });
});
