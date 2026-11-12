// The tray icon (Windows' notification area) while Spica runs, and what closing the window does.
//
// - Left click: the window comes to the front (shown first when it was hidden). A second click does not hide it.
// - Right click: 打开 Spica / 退出 Spica (the name follows deploy.json). 退出 goes through the app's own quit
//   (main/quit.ts), the same as any other quit.
// - Hovering shows the app's name.
// - The window's ×, by 设置 › 常规 › 关闭窗口时: 每次询问 (default) asks 最小化到托盘 / 退出 in the page's own
//   dialog with 「记住我的选择」 (unticked; ticked, the choice becomes the setting); closing the dialog is no choice; 最小化到托盘 hides the window, the core,
//   the plugins and running conversations go on, and the first time a notification says where Spica went;
//   退出 quits. A real quit (退出 Spica, an update, Windows signing out or shutting down, the app's own quit) is
//   never held or asked about.
// Pure logic with the Electron parts passed in; the glue is in main/index.ts.
import type { CloseWindow } from '../shared/settings';

export type TrayAction = 'open' | 'quit';

/** The right-click menu, top to bottom. */
export function trayMenuItems(appName: string): { label: string; action: TrayAction }[] {
  return [
    { label: `打开 ${appName}`, action: 'open' },
    { label: `退出 ${appName}`, action: 'quit' },
  ];
}

/** The part of Electron's Tray used here. */
export interface TrayLike {
  setToolTip(text: string): void;
  setContextMenu(menu: unknown): void;
  on(event: 'click', listener: () => void): unknown;
}

export interface TrayOptions {
  tray: TrayLike;
  appName: string;
  /** Menu.buildFromTemplate for the items (a separator between them is the caller's choice). */
  buildMenu(items: { label: string; click(): void }[]): unknown;
  open(): void;
  quit(): void;
}

export function wireTray(o: TrayOptions): void {
  o.tray.setToolTip(o.appName);
  const run = (a: TrayAction) => (a === 'open' ? o.open() : o.quit());
  o.tray.setContextMenu(o.buildMenu(trayMenuItems(o.appName).map((i) => ({ label: i.label, click: () => run(i.action) }))));
  o.tray.on('click', () => o.open());
}

/** The part of a BrowserWindow that bringing it back uses. */
export interface RevealTarget {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** Shows the window (when hidden or minimized) and brings it to the front. False when there is no window. */
export function revealWindow(win: RevealTarget | null | undefined): boolean {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return true;
}

export interface CloseState {
  /** 关闭窗口时. */
  closeWindow: CloseWindow;
  /** The app is quitting (before-quit was seen): the window closes with it. */
  quitting: boolean;
  /** Windows is signing out or shutting down (the window's query-session-end / session-end). */
  sessionEnding: boolean;
  /** The tray icon is there: without it a hidden window could not be brought back. */
  trayReady: boolean;
}

/** What the window's × does now: close it (the app quits as before), hide it in the tray, or ask. */
export function closeAction(s: CloseState): 'close' | 'hide' | 'ask' {
  if (s.quitting || s.sessionEnding || !s.trayReady) return 'close';
  if (s.closeWindow === 'tray') return 'hide';
  return s.closeWindow === 'quit' ? 'close' : 'ask';
}

/** The question on ×, as the page's dialog and the fallback message box both put it. */
export const CLOSE_QUESTION = '关闭窗口时要怎么做？';

/**
 * The fallback question: a Windows message box, seen only when the page cannot show its own dialog (its process
 * is gone, or it has not loaded yet). There 取消 is a button (the box has no other way to say no); Esc and its ×
 * are 取消 too.
 */
export function closePrompt(appName: string): { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; checkboxLabel: string } {
  return {
    message: CLOSE_QUESTION,
    detail: `最小化到托盘后，${appName} 继续运行，可以从托盘图标打开或退出。`,
    buttons: ['最小化到托盘', `退出 ${appName}`, '取消'],
    defaultId: 0,
    cancelId: 2,
    checkboxLabel: '记住我的选择',
  };
}

export type CloseAnswer = { choice: 'tray' | 'quit' | null; remember: boolean };

/** The message box's answer: which button (取消 and closing the box are no choice), and the box ticked. */
export function closeAnswer(response: number, checkboxChecked: boolean): CloseAnswer {
  const choice = response === 0 ? 'tray' : response === 1 ? 'quit' : null;
  return { choice, remember: choice !== null && checkboxChecked };
}

/** What the page sent back (anything else: no choice). */
export function parseCloseAnswer(value: unknown): CloseAnswer {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const choice = v.choice === 'tray' || v.choice === 'quit' ? v.choice : null;
  return { choice, remember: choice !== null && v.remember === true };
}

export interface AskerOptions {
  /** The page has loaded and listens for the question. */
  pageReady(): boolean;
  /** The window to the front first (minimized, or behind another window, when its taskbar button was closed). */
  reveal(): void;
  /** Tells the page to show its dialog. */
  send(): void;
  /** The message box, when the page cannot show its dialog. */
  fallback(): Promise<CloseAnswer>;
}

/**
 * Asks through the page's own dialog: the window comes to the front, the page shows the dialog and answers with
 * answer(). A page that goes or loads again before answering (pageGone()) is asked over with the message box.
 */
export function closeAsker(o: AskerOptions): { ask(): Promise<CloseAnswer>; answer(value: unknown): void; pageGone(): void } {
  let pending: ((a: CloseAnswer) => void) | null = null;
  const settle = (a: CloseAnswer) => {
    const r = pending;
    pending = null;
    r?.(a);
  };
  return {
    ask() {
      if (!o.pageReady()) return o.fallback();
      o.reveal();
      return new Promise<CloseAnswer>((resolve) => {
        settle({ choice: null, remember: false });
        pending = resolve;
        o.send();
      });
    },
    answer: (value) => settle(parseCloseAnswer(value)),
    pageGone: () => {
      const r = pending;
      pending = null;
      if (r)
        void o
          .fallback()
          .catch((): CloseAnswer => ({ choice: null, remember: false }))
          .then(r);
    },
  };
}

/** Said once, the first time the window is minimized to the tray. */
export function trayHint(appName: string): { title: string; content: string } {
  return { title: appName, content: `${appName} 已最小化到托盘，仍在运行。点托盘图标打开，右键图标可以退出。` };
}

export interface CloseOptions {
  state(): CloseState;
  hide(): void;
  quit(): void;
  /** Asks 最小化到托盘 / 退出 with 记住我的选择 (closeAsker). */
  ask(): Promise<CloseAnswer>;
  /** Keeps the choice as 关闭窗口时. */
  remember(choice: 'tray' | 'quit'): void;
  /** Whether the first-time notification was already shown (a setting, so it is said once ever). */
  hintShown(): boolean;
  /** Shows the notification and records that it was shown. */
  showHint(): void;
}

/** Returns the window's 'close' handler. One question at a time: × again while it is open does nothing. */
export function onWindowClose(o: CloseOptions): (e: { preventDefault(): void }) => void {
  let asking = false;
  const toTray = () => {
    o.hide();
    if (!o.hintShown()) o.showHint();
  };
  return (e) => {
    const action = closeAction(o.state());
    if (action === 'close') return;
    e.preventDefault();
    if (action === 'hide') return toTray();
    if (asking) return;
    asking = true;
    void o
      .ask()
      .catch((): CloseAnswer => ({ choice: null, remember: false }))
      .then((a) => {
        asking = false;
        // Quitting meanwhile (退出 from the tray menu): nothing left to do here.
        if (!a.choice || o.state().quitting) return;
        if (a.remember) o.remember(a.choice);
        if (a.choice === 'tray') toTray();
        else o.quit();
      });
  };
}
