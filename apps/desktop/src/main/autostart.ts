// 设置 › 常规 › 开机时启动: Windows starts Spica when the user signs in, for this user only (the Run key under
// HKCU, which needs no administrator rights; Electron's setLoginItemSettings writes it). The run started that way
// carries LOGIN_ARG: it opens no window and plays no opening animation, it waits in the notification area.
//
// Only an installed copy registers itself. A development run (npm run dev) would register electron.exe of the
// repository, and a portable copy runs from a folder unpacked anew under %TEMP% each time (the exe the user
// double-clicked is elsewhere and may be moved or deleted), so both show the switch disabled, with a word why.
// Pure helpers; the system call is passed in (io), so tests never touch the registry.
import type { AutostartSupport } from '../shared/settings';

/** What the registered command line carries, so the run knows Windows started it. */
export const LOGIN_ARG = '--autostart';

export function autostartSupport(o: { platform: NodeJS.Platform; packaged: boolean; portable: boolean }): AutostartSupport {
  if (o.platform !== 'win32') return 'unsupported';
  if (!o.packaged) return 'dev';
  if (o.portable) return 'portable';
  return 'ok';
}

/** This run was started by Windows at sign-in (the registered command line). */
export function startedAtLogin(argv: readonly string[]): boolean {
  return argv.includes(LOGIN_ARG);
}

/**
 * Spica started again while it runs (Start menu, desktop shortcut): no second copy; the running one's window is
 * brought to the front. A start by Windows at sign-in does not pull it up.
 */
export function onSecondLaunch(argv: readonly string[], reveal: () => void): void {
  if (!startedAtLogin(argv)) reveal();
}

/** The part of Electron's app that reads and writes the registration (app.getLoginItemSettings / setLoginItemSettings). */
export interface LoginItems {
  get(query: { path: string; args: string[] }): { openAtLogin: boolean };
  set(item: { openAtLogin: boolean; path: string; args: string[] }): void;
}

/**
 * Makes the registration match the setting. Does nothing where autostart is not offered (a development run or a
 * portable copy never writes to the registry). Returns what was done, for the log.
 */
export function syncAutostart(o: { support: AutostartSupport; want: boolean; exe: string; io: LoginItems }): 'skipped' | 'unchanged' | 'registered' | 'removed' | 'failed' {
  if (o.support !== 'ok') return 'skipped';
  const item = { path: o.exe, args: [LOGIN_ARG] };
  try {
    const now = o.io.get(item).openAtLogin;
    if (now === o.want) return 'unchanged';
    o.io.set({ ...item, openAtLogin: o.want });
    return o.want ? 'registered' : 'removed';
  } catch {
    return 'failed';
  }
}
