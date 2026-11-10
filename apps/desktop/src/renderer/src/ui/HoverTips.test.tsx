// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HoverTips, tipWanted } from './HoverTips';

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

describe('a name that may be cut short (data-tip-clipped)', () => {
  /** A box laid out `client` wide holding text `scroll` wide (jsdom lays nothing out). */
  function sized(el: HTMLElement, scroll: number, client: number, shown = true) {
    Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scroll });
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: client });
    el.getClientRects = () => (shown ? [{}] : []) as unknown as DOMRectList;
  }

  it('shows the bubble only while the name is cut off; shown in full, no bubble (and no Windows tooltip either)', () => {
    vi.useFakeTimers();
    render(
      <div>
        <HoverTips />
        <button type="button" title="整理本周来信" data-tip-clipped=".name">
          <span className="name">整理本周来信</span>
        </button>
      </div>,
    );
    const btn = screen.getByRole('button');
    const name = btn.querySelector<HTMLElement>('.name')!;
    sized(name, 80, 120);
    fireEvent.pointerOver(btn);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(btn.getAttribute('title')).toBeNull();
    fireEvent.pointerDown(btn);
    expect(btn.getAttribute('title')).toBe('整理本周来信');
    sized(name, 200, 120);
    fireEvent.pointerOver(btn);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole('tooltip').textContent).toBe('整理本周来信');
  });

  it('a name not shown at all (an icon in its place) always has its bubble; one without the mark too', () => {
    const el = document.createElement('span');
    el.setAttribute('data-tip-clipped', '');
    sized(el, 0, 0, false);
    expect(tipWanted(el)).toBe(true);
    expect(tipWanted(document.createElement('button'))).toBe(true);
  });
});
