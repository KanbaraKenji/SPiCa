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
import { win32 } from 'node:path';

const PERSONALIZE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';

/** After the last 'updated' event, how long to wait before reading the taskbar's colour. */
export const THEME_SETTLE_MS = 800;

/** `reg query` output → dark taskbar (true), light (false), or null when the value is not there. */
export function parseSystemUsesLightTheme(out: string): boolean | null {
  const m = /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
  if (!m) return null;
  return parseInt(m[1]!, 16) === 0;
}

/**
 * reg.exe by its full path in the system folder: a bare 「reg」 would first be
 * looked for next to the program and in the current folder. Null without SystemRoot.
 */
export function regExePath(env: NodeJS.ProcessEnv): string | null {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  return root && win32.isAbsolute(root) ? win32.join(root, 'System32', 'reg.exe') : null;
}

type Run = (file: string, args: string[], opts: { windowsHide: boolean; timeout: number }, done: (err: Error | null, stdout: string) => void) => void;
const runFile: Run = (file, args, opts, done) => {
  execFile(file, args, opts, (err, stdout) => done(err, String(stdout)));
};

/** The taskbar's colour from the registry; null when it cannot be read (not Windows, no SystemRoot, older Windows, reg failed). */
export function readTaskbarDark(env: NodeJS.ProcessEnv = process.env, run: Run = runFile, platform: NodeJS.Platform = process.platform): Promise<boolean | null> {
  if (platform !== 'win32') return Promise.resolve(null);
  const reg = regExePath(env);
  if (!reg) return Promise.resolve(null);
  return new Promise((resolve) => {
    run(reg, ['query', PERSONALIZE, '/v', 'SystemUsesLightTheme'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : parseSystemUsesLightTheme(stdout));
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
 * While the window can be seen, how often the taskbar's colour is read anyway. 'updated' alone is not enough
 * (inferred from Chromium's source, not measured): with a light or dark skin themeSource is fixed, and Chromium
 * then does not report a system switch; nor does it report a change of the taskbar's colour alone (Windows mode in
 * a custom setting). One read starts reg.exe: about 45 ms of wall time, measured; nothing stays running.
 */
export const VISIBLE_POLL_MS = 20_000;

export interface TaskbarFollower {
  /** nativeTheme's 'updated': a check after the settle time (events in a burst become one). */
  onUpdated(): void;
  /** The window got the focus or was shown again: a check after the settle time. */
  recheck(): void;
  /** Whether the window can be seen: while it can, the colour is read every VISIBLE_POLL_MS; hidden (tray) or minimised, never. */
  setVisible(visible: boolean): void;
}

/**
 * Applies the icon once now (nativeTheme's answer, so the window has an icon at
 * once), checks the system's own value after the settle time, and returns what
 * the window calls on 'updated', on focus or show, and when it is hidden or shown.
 */
export function followTaskbarTheme(deps: TaskbarThemeDeps): TaskbarFollower {
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
  let poll: unknown;
  const tick = () => {
    poll = deps.setTimer(tick, VISIBLE_POLL_MS);
    void check();
  };
  return {
    onUpdated: schedule,
    recheck: schedule,
    setVisible: (visible) => {
      if (visible && poll === undefined) poll = deps.setTimer(tick, VISIBLE_POLL_MS);
      else if (!visible && poll !== undefined) {
        deps.clearTimer(poll);
        poll = undefined;
      }
    },
  };
}
