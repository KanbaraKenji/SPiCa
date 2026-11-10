// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HoverTips } from './HoverTips';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the one hover note', () => {
  it('shows an element’s title in the bubble, holds the title back meanwhile, puts it back on leaving', () => {
    vi.useFakeTimers();
    render(
      <div>
        <HoverTips />
        <button type="button" title="删除">x</button>
        <span data-tip="128,000 token">128k</span>
        <p>plain</p>
      </div>,
    );
    const btn = screen.getByRole('button', { name: 'x' });
    fireEvent.pointerOver(btn);
    // Windows' own tooltip has nothing to show while ours is up.
    expect(btn.getAttribute('title')).toBeNull();
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole('tooltip').textContent).toBe('删除');
    fireEvent.pointerOver(screen.getByText('plain'));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(btn.getAttribute('title')).toBe('删除');
    fireEvent.pointerOver(screen.getByText('128k'));
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole('tooltip').textContent).toBe('128,000 token');
    fireEvent.pointerDown(screen.getByText('128k'));
    expect(screen.queryByRole('tooltip')).toBeNull();
    // A click (also one from the keyboard) hides it too.
    fireEvent.pointerOver(screen.getByText('plain'));
    fireEvent.pointerOver(screen.getByText('128k'));
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.click(screen.getByText('128k'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('not for an iframe’s title (its name for screen readers)', () => {
    vi.useFakeTimers();
    render(
      <div>
        <HoverTips />
        <iframe title="插件页面" />
      </div>,
    );
    fireEvent.pointerOver(screen.getByTitle('插件页面'));
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
