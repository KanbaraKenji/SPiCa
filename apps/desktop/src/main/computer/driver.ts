// What 操作电脑 needs from the system: the screen's windows and picture, input, starting and bringing a program to
// the front, watching the person's Escape key. Two of them: the real one (driver-win32.ts, Windows through koffi)
// and a made-up desktop (fake-driver.ts) for tests, test windows and the demo backend, which never touches the real
// screen, mouse or keyboard.
import type { Bitmap, Rect } from './bitmap';
import type { InputStep } from './input';

/** A visible top-level window. */
export interface WindowInfo {
  /** The window's handle (a number that names it while it is open). */
  id: number;
  pid: number;
  /** The program's exe, full path ('' when it could not be read: such a window counts as not allowed). */
  exe: string;
  title: string;
  /** Where it is on the screen, in screen pixels. */
  rect: Rect;
  /** Runs with higher rights than Spica (as administrator): input sent to it is dropped by Windows without a word. */
  elevated: boolean;
}

export interface Driver {
  readonly kind: 'real' | 'fake';
  /** The main screen's size in its own pixels (the picture's size; clicks are in the same pixels). */
  screen(): { width: number; height: number };
  /** Visible top-level windows on the main screen, the top one first. */
  windows(): Promise<WindowInfo[]>;
  /** A picture of the main screen. */
  capture(): Promise<Bitmap>;
  /** Sends the steps in order (a click: move, button down, button up). */
  send(steps: readonly InputStep[]): Promise<void>;
  /** The window in front (the one typing goes to), when there is one. */
  foreground(): Promise<number | undefined>;
  /** Brings a window to the front; false when the system did not let it. */
  focus(windowId: number): Promise<boolean>;
  /** Starts a program. */
  launch(exe: string): Promise<void>;
  /** A program's name for people (its file description), else the exe's name. */
  describe(exe: string): Promise<string>;
  /** The program's icon as a small PNG data URL, when there is one. */
  icon(exe: string): Promise<string | undefined>;
  /** Where a program that is not running is: its exe for a name like "notepad" or "excel.exe" (PATH, App Paths). */
  locate(name: string): Promise<string | undefined>;
  /** Spica's own processes (never operated, never seen). */
  ownPids(): ReadonlySet<number>;
  /** Calls back when the person presses Escape on the real keyboard (not the agent's own keys); returns the stop. */
  watchEscape(onEscape: () => void): () => void;
}

/**
 * Whether 操作电脑 is there at all, and on which driver. Until the real driver has been checked on a real machine
 * it is off everywhere, installed copies too: no computer_* tools for the agent, no 操作电脑 in the settings.
 *   SPICA_COMPUTER=real  the real driver, on Windows; in a test window (SPICA_HIDDEN), with the demo backend or
 *                        under the tests the made-up desktop instead, so they never reach the real screen
 *   SPICA_COMPUTER=fake  the made-up desktop (development runs only: tests and screenshots)
 *   anything else        off
 */
export function computerMode(env: Record<string, string | undefined>, opts: { packaged: boolean; platform: string }): 'off' | 'real' | 'fake' {
  if (env.SPICA_COMPUTER === 'fake') return opts.packaged ? 'off' : 'fake';
  if (env.SPICA_COMPUTER !== 'real') return 'off';
  if (opts.platform !== 'win32' || env.SPICA_HIDDEN === '1' || env.SPICA_BACKEND === 'fake' || env.VITEST) return 'fake';
  return 'real';
}

/** The window on top at a point, or undefined (nothing there). */
export function windowAt(windows: readonly WindowInfo[], x: number, y: number): WindowInfo | undefined {
  return windows.find((w) => x >= w.rect.x && y >= w.rect.y && x < w.rect.x + w.rect.width && y < w.rect.y + w.rect.height);
}
