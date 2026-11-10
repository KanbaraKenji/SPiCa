// Which colour the Windows taskbar is, for the taskbar icon (white flower on a
// dark taskbar, black on a light one).
//
// Electron's nativeTheme.shouldUseDarkColorsForSystemIntegratedUI cannot be
// read at any moment: right after the app sets themeSource (a light or dark
// skin) it briefly follows the app's scheme, not the taskbar's, and when the
// system switches it can still hold the old value when 'updated' arrives.
// The taskbar's own setting is the registry value SystemUsesLightTheme
// (HKCU\...\Themes\Personalize). So after an 'updated' event this waits until
// things have settled, reads that value (nativeTheme only when it cannot be
// read), and redraws only when the colour actually changed.
import { execFile } from 'node:child_process';

const PERSONALIZE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';

/** After the last 'updated' event, how long to wait before reading the taskbar's colour. */
export const THEME_SETTLE_MS = 800;

/** `reg query` output → dark taskbar (true), light (false), or null when the value is not there. */
export function parseSystemUsesLightTheme(out: string): boolean | null {
  const m = /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
  if (!m) return null;
  return parseInt(m[1]!, 16) === 0;
}

/** The taskbar's colour from the registry; null when it cannot be read (not Windows, older Windows, reg failed). */
export function readTaskbarDark(): Promise<boolean | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('reg', ['query', PERSONALIZE, '/v', 'SystemUsesLightTheme'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : parseSystemUsesLightTheme(String(stdout)));
    });
  });
}

export interface TaskbarThemeDeps {
  /** The taskbar's colour as the system stores it; null: unknown. */
  readTaskbarDark(): Promise<boolean | null>;
  /** nativeTheme's answer, used when the system's own cannot be read. */
  nativeDark(): boolean;
  /** Draws the icon for a dark (true) or light taskbar. */
  apply(dark: boolean): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/**
 * Applies the icon once now (nativeTheme's answer, so the window has an icon at
 * once), checks the system's own value after the settle time, and returns the
 * handler for nativeTheme's 'updated': events in a burst become one check.
 */
export function followTaskbarTheme(deps: TaskbarThemeDeps): { onUpdated(): void } {
  let shown = deps.nativeDark();
  deps.apply(shown);
  let timer: unknown;
  let run = 0;
  const check = async () => {
    const mine = ++run;
    const fromSystem = await deps.readTaskbarDark();
    if (mine !== run) return;
    const dark = fromSystem ?? deps.nativeDark();
    if (dark === shown) return;
    shown = dark;
    deps.apply(dark);
  };
  const schedule = () => {
    if (timer !== undefined) deps.clearTimer(timer);
    timer = deps.setTimer(() => {
      timer = undefined;
      void check();
    }, THEME_SETTLE_MS);
  };
  // Startup: the skin's themeSource is set right after the window, which can sway nativeTheme for a moment.
  schedule();
  return { onUpdated: schedule };
}
