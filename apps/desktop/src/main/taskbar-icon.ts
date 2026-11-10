// The taskbar button of an installed Spica. Windows draws it with the icon of
// the shortcut that carries the same AppUserModelID (the Start menu one, or a
// pinned one), not with the window's own icon; and it reads that shortcut only
// when the button is created. Measured on an installed copy (2026-11-10):
// - changing only the window's icon (setAppDetails appIconPath) changes nothing;
// - rewriting the shortcut's icon alone changes nothing while the app runs;
// - rewriting it, waiting ~3 s (Explorer takes a moment to notice), then giving
//   the window a passing AppUserModelID and its own back makes the button take
//   the new icon at once, with no second button or flicker.
// So: the colour-matched icon is written to a file named after its content (a
// new colour is a new path, which Explorer's icon cache keys on), the shortcuts
// that start this exe are pointed at it, and the button is refreshed.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Folders whose shortcuts give the taskbar button its icon. Not the desktop: its wallpaper is not the taskbar. */
export function shortcutFolders(appData: string): string[] {
  return [
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
  ];
}

/** `taskbar-<first 12 hex of sha256>.ico`: another colour (or a custom palette later) is another file. */
export function iconFileName(ico: Uint8Array): string {
  return `taskbar-${createHash('sha256').update(ico).digest('hex').slice(0, 12)}.ico`;
}

export interface Shortcut {
  target: string;
  icon?: string;
  iconIndex?: number;
}

export interface ShortcutIo {
  /** .lnk files directly in `dir` (none when it does not exist). */
  list(dir: string): string[];
  read(path: string): Shortcut | null;
  /** Points the shortcut's icon at `icon`; false when it could not. */
  setIcon(path: string, icon: string): boolean;
}

const samePath = (a: string, b: string) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();

/**
 * Points every shortcut in `folders` that starts `exe` at `icon` (unless it
 * already shows it). Returns how many were changed.
 */
export function pointShortcutsAt(io: ShortcutIo, folders: string[], exe: string, icon: string): number {
  let changed = 0;
  for (const dir of folders) {
    for (const file of io.list(dir)) {
      const s = io.read(file);
      if (!s || !samePath(s.target, exe)) continue;
      if (s.icon && samePath(s.icon, icon) && (s.iconIndex ?? 0) === 0) continue;
      if (io.setIcon(file, icon)) changed++;
    }
  }
  return changed;
}

/** How long Explorer takes to notice a rewritten shortcut before the button can be refreshed (measured ~2–3 s). */
export const SHORTCUT_SETTLE_MS = 3500;
/** How long the window carries the passing id (300 ms was enough; no second button showed). */
export const REFRESH_GAP_MS = 300;
