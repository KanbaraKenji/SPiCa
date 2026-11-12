import { describe, expect, it, vi } from 'vitest';
import { backgroundHint, closeAction, onWindowClose, revealWindow, showAtStart, trayMenuItems, wireTray, type CloseState, type RevealTarget, type TrayLike } from './tray';

describe('the notification-area icon', () => {
  it('right-click menu: open, then quit, with the app name', () => {
    expect(trayMenuItems('Spica')).toEqual([
      { label: '打开 Spica', action: 'open' },
      { label: '退出 Spica', action: 'quit' },
    ]);
    expect(trayMenuItems('Acme').map((i) => i.label)).toEqual(['打开 Acme', '退出 Acme']);
  });

  it('hover shows the name; a click opens; the menu items open and quit', () => {
    let click: (() => void) | undefined;
    let menu: { label: string; click(): void }[] = [];
    const tray: TrayLike = { setToolTip: vi.fn(), setContextMenu: vi.fn(), on: (_e, fn) => (click = fn) };
    const open = vi.fn();
    const quit = vi.fn();
    wireTray({ tray, appName: 'Spica', buildMenu: (items) => (menu = items), open, quit });
    expect(tray.setToolTip).toHaveBeenCalledWith('Spica');
    expect(tray.setContextMenu).toHaveBeenCalledWith(menu);
    click?.();
    click?.();
    expect(open).toHaveBeenCalledTimes(2);
    expect(quit).not.toHaveBeenCalled();
    menu[0]?.click();
    expect(open).toHaveBeenCalledTimes(3);
    menu[1]?.click();
    expect(quit).toHaveBeenCalledTimes(1);
  });
});

function win(over: Partial<{ destroyed: boolean; minimized: boolean; visible: boolean }> = {}) {
  const calls: string[] = [];
  const w: RevealTarget = {
    isDestroyed: () => over.destroyed ?? false,
    isMinimized: () => over.minimized ?? false,
    isVisible: () => over.visible ?? true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
  return { w, calls };
}

describe('bringing the window back', () => {
  it('a hidden window is shown, then focused', () => {
    const { w, calls } = win({ visible: false });
    expect(revealWindow(w)).toBe(true);
    expect(calls).toEqual(['show', 'focus']);
  });
  it('a shown one only comes to the front (a second click does not hide it)', () => {
    const { w, calls } = win();
    revealWindow(w);
    revealWindow(w);
    expect(calls).toEqual(['focus', 'focus']);
  });
  it('a minimized one is restored', () => {
    const { w, calls } = win({ minimized: true });
    revealWindow(w);
    expect(calls).toEqual(['restore', 'focus']);
  });
  it('no window: nothing', () => {
    expect(revealWindow(null)).toBe(false);
    expect(revealWindow(win({ destroyed: true }).w)).toBe(false);
  });
});

const base: CloseState = { keepInBackground: true, quitting: false, sessionEnding: false, trayReady: true };

describe('the close button of the window', () => {
  it('with 关闭窗口后留在后台 off, closes as before (the app quits)', () => {
    expect(closeAction({ ...base, keepInBackground: false })).toBe('close');
  });
  it('with it on, hides', () => {
    expect(closeAction(base)).toBe('hide');
  });
  it('a real quit, Windows signing out, or no icon to come back by: closes', () => {
    expect(closeAction({ ...base, quitting: true })).toBe('close');
    expect(closeAction({ ...base, sessionEnding: true })).toBe('close');
    expect(closeAction({ ...base, trayReady: false })).toBe('close');
  });

  it('hiding holds the close; the notification is said once', () => {
    let shown = false;
    const hide = vi.fn();
    const showHint = vi.fn(() => {
      shown = true;
    });
    let state = base;
    const handler = onWindowClose({ state: () => state, hide, hintShown: () => shown, showHint });
    const e1 = { preventDefault: vi.fn() };
    handler(e1);
    handler({ preventDefault: vi.fn() });
    expect(e1.preventDefault).toHaveBeenCalled();
    expect(hide).toHaveBeenCalledTimes(2);
    expect(showHint).toHaveBeenCalledTimes(1);
    state = { ...base, quitting: true };
    const e3 = { preventDefault: vi.fn() };
    handler(e3);
    expect(e3.preventDefault).not.toHaveBeenCalled();
    expect(hide).toHaveBeenCalledTimes(2);
  });

  it('the notification names the app and where it went', () => {
    expect(backgroundHint('Spica')).toEqual({ title: 'Spica', content: 'Spica 仍在后台运行。点右下角的图标打开，右键图标可以退出。' });
  });
});

describe('the window at start', () => {
  it('shows, except for a start by Windows at sign-in (unless there is no icon)', () => {
    expect(showAtStart({ atLogin: false, trayReady: true })).toBe(true);
    expect(showAtStart({ atLogin: true, trayReady: true })).toBe(false);
    expect(showAtStart({ atLogin: true, trayReady: false })).toBe(true);
  });
});
