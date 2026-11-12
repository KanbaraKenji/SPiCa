// When the window's page process (the renderer) is gone. Seen after Windows ran short of memory: the GPU process
// crashed three times, the renderer went with it and was never started again, so the window stayed black while
// the core and the plugins went on; every message sent to the window from then on printed
// "Render frame was disposed before WebFrameMain could be accessed" (2029 times in one run).
//
// Now: one line in the log (reason, exit code), and the page is loaded again (a new renderer), back on the
// conversation that was open. The third loss within a minute is not retried by itself: a Windows message box
// (drawn without the page, so it shows even when the page cannot) offers 重新加载 / 退出 Spica.
// Messages for the window are sent only while its page is there (pageAlive).

/** Losses counted together: within this long of each other. */
export const LOSS_WINDOW_MS = 60_000;
/** Automatic reloads within LOSS_WINDOW_MS; the next loss asks. */
export const AUTO_RELOADS = 2;

/** What Electron tells about a lost page (render-process-gone). */
export interface PageGone {
  reason: string;
  exitCode: number;
}

/** The part of a BrowserWindow that sending looks at. */
export interface SendTarget {
  isDestroyed(): boolean;
  webContents: { isDestroyed(): boolean; isCrashed(): boolean };
}

/** True when a message sent to the window now reaches a page: the window and its page are there. */
export function pageAlive(win: SendTarget | null | undefined): win is SendTarget {
  return Boolean(win && !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed());
}

export interface RecoveryOptions {
  /** The app is quitting: a page that goes now is not brought back. */
  quitting(): boolean;
  /** Loads the page again (a new renderer). */
  reload(): void;
  /** Shows the message box; resolves true for 重新加载, false for 退出 Spica. */
  ask(): Promise<boolean>;
  quit(): void;
  warn(line: string): void;
  now?: () => number;
}

/** Returns the handler for the window's render-process-gone. */
export function pageRecovery(o: RecoveryOptions): (gone: PageGone) => void {
  const now = o.now ?? (() => Date.now());
  let losses: number[] = [];
  let asking = false;
  return (gone) => {
    // The page closing with the window (quit) is not a loss.
    if (gone.reason === 'clean-exit' || o.quitting()) return;
    const t = now();
    losses = [...losses.filter((x) => t - x < LOSS_WINDOW_MS), t];
    const what = `[spica] window: page process gone (${gone.reason}, exit code ${gone.exitCode})`;
    if (losses.length <= AUTO_RELOADS) {
      o.warn(`${what}; reloading`);
      o.reload();
      return;
    }
    if (asking) return;
    asking = true;
    o.warn(`${what}; ${losses.length} times within a minute, asking before reloading`);
    void o
      .ask()
      .catch(() => true)
      .then((again) => {
        asking = false;
        if (o.quitting()) return;
        if (!again) return o.quit();
        // A reload the user asked for starts the count again.
        losses = [];
        o.reload();
      });
  };
}
