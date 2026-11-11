// How the app quits. The first quit hides the windows (nobody waits on a window that does nothing) and is held
// while the core closes (running conversations become interrupted, plugin servers and what they started are
// ended), at most stopLimitMs; then the app quits for real. If the
// process is still here exitAfterMs after that (seen on one machine: everything else gone, the main process
// left running), it is ended with app.exit. A development run logs each step, so a report can tell whether the
// quit stopped short of will-quit / quit or hung after them.

/** How long a quitting core may take before it is killed: with plugins it takes some 4.5 s, more on a slow machine. */
export const CORE_KILL_MS = 10_000;
/** The first quit waits for the core a little longer than that, so the kill comes from the core's own guard. */
export const STOP_LIMIT_MS = CORE_KILL_MS + 1000;

export interface QuitEvent {
  preventDefault(): void;
}

/** The part of Electron's app the quit uses. */
export interface QuitApp {
  on(event: 'before-quit', listener: (e: QuitEvent) => void): unknown;
  on(event: 'will-quit' | 'quit', listener: () => void): unknown;
  quit(): void;
  exit(code?: number): void;
}

export interface QuitOptions {
  app: QuitApp;
  /** Saves what is pending (settings); runs on every before-quit. */
  flush(): void;
  /** Hides the windows still open (a quit that did not start from closing the window, such as an update). */
  hide(): void;
  /** Closes the core and the plugin servers. */
  stop(): Promise<unknown>;
  /** The longest the first quit waits for stop(). */
  stopLimitMs: number;
  /** After the real quit, how long the process may still be here before app.exit. */
  exitAfterMs: number;
  /** One line per step (development runs); the forced exit is always told. */
  log(line: string): void;
  warn(line: string): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export function wireQuit(o: QuitOptions): void {
  const timer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  let quitting = false;
  const seen: string[] = [];
  o.app.on('before-quit', (e) => {
    o.flush();
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    try {
      o.hide();
    } catch {
      // A window that cannot be hidden still closes with the real quit.
    }
    o.log('[spica] quit: closing the core');
    const limit = new Promise((r) => timer(() => r(undefined), o.stopLimitMs));
    void Promise.race([o.stop(), limit])
      .catch(() => undefined)
      .finally(() => {
        o.log('[spica] quit: core closed, quitting');
        o.app.quit();
        timer(() => {
          o.warn(`[spica] quit: still running ${o.exitAfterMs} ms after quitting (${seen.join(', ') || 'no will-quit, no quit'}); exiting`);
          o.app.exit(0);
        }, o.exitAfterMs);
      });
  });
  o.app.on('will-quit', () => {
    seen.push('will-quit');
    o.log('[spica] quit: will-quit');
  });
  o.app.on('quit', () => {
    seen.push('quit');
    o.log('[spica] quit: quit');
  });
}
