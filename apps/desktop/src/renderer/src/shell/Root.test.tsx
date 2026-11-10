// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

// The brand animation itself is the brand's; here only when Root tells it loading is done.
vi.mock('@spica/brand/react', () => ({
  SpicaMark: () => <span data-testid="mark" />,
  SpicaSplash: ({ ready }: { ready: boolean }) => <span data-testid="splash" data-ready={String(ready)} />,
}));

import { Root, SPLASH_LOADING_AT_LEAST_MS, SPLASH_TOTAL_MS } from './Root';
import { SPLASH_FINISH_AFTER } from '@spica/brand';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const readyNow = () => Promise.resolve();

describe('Root', () => {
  it('the full opening runs about 10 s: loading part held, then the brand finish', () => {
    expect(SPLASH_LOADING_AT_LEAST_MS + SPLASH_FINISH_AFTER * 1000).toBeCloseTo(SPLASH_TOTAL_MS, -2);
    expect(SPLASH_LOADING_AT_LEAST_MS).toBeGreaterThan(4000);
  });

  it('full: start-up done at once still keeps the loading part going', async () => {
    vi.useFakeTimers();
    render(
      <Root splash="full" ready={readyNow()} version="0.1.0">
        <p>app</p>
      </Root>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPLASH_LOADING_AT_LEAST_MS - 100);
    });
    expect(screen.getByTestId('splash').dataset.ready).toBe('false');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByTestId('splash').dataset.ready).toBe('true');
  });

  it('full: slow start-up is waited for', async () => {
    vi.useFakeTimers();
    let done!: () => void;
    const ready = new Promise<void>((r) => (done = r));
    render(
      <Root splash="full" ready={ready} version="0.1.0">
        <p>app</p>
      </Root>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPLASH_LOADING_AT_LEAST_MS + 3000);
    });
    expect(screen.getByTestId('splash').dataset.ready).toBe('false');
    await act(async () => {
      done();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('splash').dataset.ready).toBe('true');
  });

  it('brief and none do not wait', () => {
    render(
      <Root splash="brief" ready={readyNow()} version="0.1.0">
        <p>app</p>
      </Root>,
    );
    expect(screen.queryByTestId('splash')).toBeNull();
    expect(screen.getByTestId('mark')).toBeTruthy();
  });
});
