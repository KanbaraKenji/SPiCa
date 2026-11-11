import { describe, expect, it, vi } from 'vitest';
import { CORE_KILL_MS, STOP_LIMIT_MS, wireQuit, type QuitApp, type QuitEvent } from './quit';

/** An app that records what is asked of it; emit() plays an Electron event. */
function fakeApp() {
  const listeners: Record<string, ((e?: QuitEvent) => void)[]> = {};
  const calls: string[] = [];
  const app: QuitApp & { emit(name: string): boolean } = {
    on(event: string, fn: (e?: QuitEvent) => void) {
      (listeners[event] ??= []).push(fn);
      return app;
    },
    quit: () => calls.push('quit()'),
    exit: (code?: number) => calls.push(`exit(${code})`),
    emit(name: string) {
      let prevented = false;
      for (const fn of listeners[name] ?? []) fn({ preventDefault: () => (prevented = true) });
      return prevented;
    },
  } as never;
  return { app, calls };
}

function setup(stop: () => Promise<unknown>, hide: () => void = () => undefined) {
  vi.useFakeTimers();
  const { app, calls } = fakeApp();
  const lines: string[] = [];
  const flush = vi.fn();
  const hidden = vi.fn(hide);
  wireQuit({ app, flush, hide: hidden, stop, stopLimitMs: 6000, exitAfterMs: 3000, log: (l) => lines.push(l), warn: (l) => lines.push(`WARN ${l}`) });
  return { app, calls, lines, flush, hidden };
}

describe('quitting', () => {
  it('the windows go first: hidden before the core is asked to close, once', async () => {
    const order: string[] = [];
    const { app, hidden } = setup(
      () => {
        order.push('stop');
        return Promise.resolve();
      },
      () => order.push('hide'),
    );
    app.emit('before-quit');
    expect(order).toEqual(['hide', 'stop']);
    await vi.advanceTimersByTimeAsync(0);
    app.emit('before-quit');
    expect(hidden).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('a window that cannot be hidden does not stop the quit', async () => {
    const { app, calls } = setup(
      () => Promise.resolve(),
      () => {
        throw new Error('destroyed');
      },
    );
    expect(app.emit('before-quit')).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['quit()']);
    vi.useRealTimers();
  });

  it('the core gets 10 s before it is killed; the quit waits a little longer, so the core’s own guard comes first', () => {
    expect(CORE_KILL_MS).toBe(10_000);
    expect(STOP_LIMIT_MS).toBeGreaterThan(CORE_KILL_MS);
  });

  it('holds the first quit while the core closes, then quits for real; nothing forced when the process goes', async () => {
    let done!: () => void;
    const { app, calls, flush } = setup(() => new Promise<void>((r) => (done = r)));
    expect(app.emit('before-quit')).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([]);
    done();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['quit()']);
    // The second before-quit (from that quit) goes through, still saving.
    expect(app.emit('before-quit')).toBe(false);
    expect(flush).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('a core that does not close in time: quits anyway after the limit', async () => {
    const { calls } = (() => {
      const s = setup(() => new Promise(() => undefined));
      s.app.emit('before-quit');
      return s;
    })();
    await vi.advanceTimersByTimeAsync(5999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['quit()']);
    vi.useRealTimers();
  });

  it('still here 3 s after the real quit (will-quit and quit never came): app.exit, and says what was seen', async () => {
    const { app, calls, lines } = setup(() => Promise.resolve());
    app.emit('before-quit');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['quit()']);
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls).toEqual(['quit()']);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['quit()', 'exit(0)']);
    expect(lines.at(-1)).toBe('WARN [spica] quit: still running 3000 ms after quitting (no will-quit, no quit); exiting');
    vi.useRealTimers();
  });

  it('logs will-quit and quit, and names them if the process still hangs after them', async () => {
    const { app, calls, lines } = setup(() => Promise.resolve());
    app.emit('before-quit');
    await vi.advanceTimersByTimeAsync(0);
    app.emit('before-quit');
    app.emit('will-quit');
    app.emit('quit');
    expect(lines).toEqual(['[spica] quit: closing the core', '[spica] quit: core closed, quitting', '[spica] quit: will-quit', '[spica] quit: quit']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toEqual(['quit()', 'exit(0)']);
    expect(lines.at(-1)).toContain('(will-quit, quit)');
    vi.useRealTimers();
  });
});
