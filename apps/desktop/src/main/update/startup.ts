// What a downloaded update does in the first minutes after the app starts, as the mainstream apps do it: an update
// found then is asked about once in a dialog (立即更新 / 稍后); a version that must update is installed at once,
// without asking. Found later, it is only the side bar's card (and 自动更新 installs it when nobody is using the
// computer, main/update/schedule.ts).
import type { UpdateState } from '../../shared/updates';

/** An update downloaded within this long after the app started counts as found at start. */
export const STARTUP_WINDOW_MS = 2 * 60_000;

export interface StartupInput {
  update: UpdateState;
  /** Milliseconds since the app started. */
  sinceStartMs: number;
  /** A conversation is running (or waits on a confirmation or an answer). */
  busy: boolean;
  /** The main window is on screen (not started into the tray). */
  shown: boolean;
  /** This start already asked (or already installs). */
  done: boolean;
}

/**
 * ask: show the dialog; force: the version must update, install now (the window shows the download first);
 * null: nothing (the side bar's card says it).
 */
export function startupAction(i: StartupInput): 'ask' | 'force' | null {
  if (i.done || i.sinceStartMs > STARTUP_WINDOW_MS || i.update.portable) return null;
  if (i.update.required && (i.update.status === 'downloading' || i.update.status === 'ready')) return 'force';
  if (i.update.status !== 'ready' || i.busy || !i.shown) return null;
  return 'ask';
}
