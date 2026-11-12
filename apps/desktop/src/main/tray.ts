// The icon in Windows' notification area (bottom right) while Spica runs, and what closing the window does.
//
// - Left click: the window comes to the front (shown first when it was hidden). A second click does not hide it.
// - Right click: 打开 Spica / 退出 Spica (the name follows deploy.json). 退出 goes through the app's own quit
//   (main/quit.ts), the same as any other quit.
// - Hovering shows the app's name.
// - 设置 › 常规 › 关闭窗口后留在后台 (off by default): with it on, the window's × only hides the window; the core,
//   the plugins and running conversations go on. The first time, a notification says where Spica went.
//   A real quit (退出 Spica, an update, Windows signing out or shutting down, the app's own quit) is never held.
// Pure logic with the Electron parts passed in; the glue is in main/index.ts.

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
  /** 关闭窗口后留在后台. */
  keepInBackground: boolean;
  /** The app is quitting (before-quit was seen): the window closes with it. */
  quitting: boolean;
  /** Windows is signing out or shutting down (the window's query-session-end / session-end). */
  sessionEnding: boolean;
  /** The notification-area icon is there: without it a hidden window could not be brought back. */
  trayReady: boolean;
}

/** What the window's × does now: hide it (the app stays) or let it close (the app quits as before). */
export function closeAction(s: CloseState): 'hide' | 'close' {
  if (s.quitting || s.sessionEnding || !s.trayReady) return 'close';
  return s.keepInBackground ? 'hide' : 'close';
}

/** Said once, the first time the window goes to the background. */
export function backgroundHint(appName: string): { title: string; content: string } {
  return { title: appName, content: `${appName} 仍在后台运行。点右下角的图标打开，右键图标可以退出。` };
}

export interface BackgroundOptions {
  state(): CloseState;
  hide(): void;
  /** Whether the first-time notification was already shown (a setting, so it is said once ever). */
  hintShown(): boolean;
  /** Shows the notification and records that it was shown. */
  showHint(): void;
}

/** Returns the window's 'close' handler. */
export function onWindowClose(o: BackgroundOptions): (e: { preventDefault(): void }) => void {
  return (e) => {
    if (closeAction(o.state()) === 'close') return;
    e.preventDefault();
    o.hide();
    if (!o.hintShown()) o.showHint();
  };
}

/** Whether the window shows once its page is ready: not for a run Windows started at sign-in (it waits in the notification area). */
export function showAtStart(o: { atLogin: boolean; trayReady: boolean }): boolean {
  // Without the icon nothing could open it: show it after all.
  return !o.atLogin || !o.trayReady;
}
