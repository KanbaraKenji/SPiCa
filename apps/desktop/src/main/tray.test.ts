import { describe, expect, it, vi } from 'vitest';
import { CLOSE_QUESTION, closeDialogSpec, closeFromDialog, dialogFromBox, runningTracker, closeAction, closeAnswer, closeAsker, closePrompt, onWindowClose, parseCloseAnswer, revealWindow, trayHint, trayMenuItems, wireTray, type CloseAnswer, type CloseState, type RevealTarget, type TrayLike } from './tray';
import { CLOSE_RUNNING } from '../shared/close-words';

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

const base: CloseState = { closeWindow: 'ask', quitting: false, sessionEnding: false, trayReady: true };

describe('what the window’s close button does', () => {
  it('关闭窗口时: 每次询问 asks, 最小化到托盘 hides, 退出 closes (the app quits as before)', () => {
    expect(closeAction(base)).toBe('ask');
    expect(closeAction({ ...base, closeWindow: 'tray' })).toBe('hide');
    expect(closeAction({ ...base, closeWindow: 'quit' })).toBe('close');
  });
  it('a real quit, Windows signing out, or no tray icon to come back by: closes without asking', () => {
    for (const closeWindow of ['ask', 'tray'] as const) {
      expect(closeAction({ ...base, closeWindow, quitting: true })).toBe('close');
      expect(closeAction({ ...base, closeWindow, sessionEnding: true })).toBe('close');
      expect(closeAction({ ...base, closeWindow, trayReady: false })).toBe('close');
    }
  });

  it('the question: two choices and 取消, 不再提醒 unticked, named after the app', () => {
    const p = closePrompt('Acme');
    expect(p.buttons).toEqual(['最小化到托盘', '退出 Acme', '取消']);
    expect(p.checkboxLabel).toBe('不再提醒');
    expect(p.cancelId).toBe(2);
    // nothing explained; one line only while a task runs
    expect(p).not.toHaveProperty('detail');
    expect(closePrompt('Acme', true).detail).toBe(CLOSE_RUNNING);
    expect(closeAnswer(0, false)).toEqual({ choice: 'tray', remember: false });
    expect(closeAnswer(1, true)).toEqual({ choice: 'quit', remember: true });
    expect(closeAnswer(2, true)).toEqual({ choice: null, remember: false });
  });

  it('when the page cannot ask: the small window asks the same (the line only while a task runs); the message box answers the same way', () => {
    const look = { scheme: 'dark' as const, tokens: {} };
    expect(closeDialogSpec('Acme', false, look)).toEqual({
      title: CLOSE_QUESTION,
      detail: [],
      choices: { options: ['最小化到托盘', '退出 Acme'], selected: 0 },
      buttons: [{ label: '确定', primary: true }],
      check: '不再提醒',
      checkInFoot: true,
      closeButton: true,
      width: 360,
      ...look,
    });
    expect(closeDialogSpec('Acme', true, look).detail).toEqual([CLOSE_RUNNING]);
    // 确定 with 最小化到托盘 / 退出 selected, 不再提醒 ticked or not
    expect(closeFromDialog({ button: 0, checked: false, choice: 0 })).toEqual({ choice: 'tray', remember: false });
    expect(closeFromDialog({ button: 0, checked: false, choice: 1 })).toEqual({ choice: 'quit', remember: false });
    expect(closeFromDialog({ button: 0, checked: true, choice: 1 })).toEqual({ choice: 'quit', remember: true });
    // the × or the window closed: no choice, a ticked 不再提醒 not kept
    expect(closeFromDialog({ button: null, checked: true, choice: 0 })).toEqual({ choice: null, remember: false });
    // the box: 最小化到托盘, 退出, 取消
    expect(closeFromDialog(dialogFromBox(0, true))).toEqual({ choice: 'tray', remember: true });
    expect(closeFromDialog(dialogFromBox(1, false))).toEqual({ choice: 'quit', remember: false });
    expect(closeFromDialog(dialogFromBox(2, true))).toEqual({ choice: null, remember: false });
  });

  it('knows whether a conversation is running from the core\'s status events', () => {
    const r = runningTracker();
    expect(r.any()).toBe(false);
    r.seen({ type: 'status', sessionId: 'a', status: 'thinking' });
    r.seen({ type: 'status', sessionId: 'b', status: 'awaiting_answer' });
    r.seen({ type: 'text.delta', sessionId: 'a' });
    expect(r.any()).toBe(true);
    r.seen({ type: 'status', sessionId: 'a', status: 'idle' });
    expect(r.any()).toBe(true);
    r.seen({ type: 'status', sessionId: 'b', status: 'aborted' });
    expect(r.any()).toBe(false);
  });
});

function closer(state: () => CloseState) {
  let shown = false;
  let answer: (a: CloseAnswer) => void = () => undefined;
  const o = {
    state,
    hide: vi.fn(),
    quit: vi.fn(),
    ask: vi.fn(() => new Promise<CloseAnswer>((r) => (answer = r))),
    remember: vi.fn(),
    hintShown: () => shown,
    showHint: vi.fn(() => {
      shown = true;
    }),
  };
  const handler = onWindowClose(o);
  const close = () => {
    const e = { preventDefault: vi.fn() };
    handler(e);
    return e.preventDefault.mock.calls.length > 0;
  };
  return { o, close, answer: async (a: CloseAnswer) => {
    answer(a);
    await new Promise((r) => setTimeout(r, 0));
  } };
}

describe('closing the window', () => {
  it('每次询问 → 最小化到托盘, not remembered: hidden, the notification once, asked again next time', async () => {
    const c = closer(() => base);
    expect(c.close()).toBe(true);
    await c.answer({ choice: 'tray', remember: false });
    expect(c.o.hide).toHaveBeenCalledTimes(1);
    expect(c.o.remember).not.toHaveBeenCalled();
    expect(c.o.showHint).toHaveBeenCalledTimes(1);
    c.close();
    expect(c.o.ask).toHaveBeenCalledTimes(2);
    await c.answer({ choice: 'tray', remember: false });
    expect(c.o.showHint).toHaveBeenCalledTimes(1);
  });

  it('remembered choices become the setting', async () => {
    const c = closer(() => base);
    c.close();
    await c.answer({ choice: 'tray', remember: true });
    expect(c.o.remember).toHaveBeenCalledWith('tray');
    c.close();
    await c.answer({ choice: 'quit', remember: true });
    expect(c.o.remember).toHaveBeenLastCalledWith('quit');
    expect(c.o.quit).toHaveBeenCalledTimes(1);
  });

  it('取消 or closing the box: the window stays, nothing kept', async () => {
    const c = closer(() => base);
    c.close();
    await c.answer({ choice: null, remember: false });
    expect(c.o.hide).not.toHaveBeenCalled();
    expect(c.o.quit).not.toHaveBeenCalled();
    expect(c.o.remember).not.toHaveBeenCalled();
  });

  it('× again while the question is open does not ask twice', async () => {
    const c = closer(() => base);
    expect(c.close()).toBe(true);
    expect(c.close()).toBe(true);
    expect(c.o.ask).toHaveBeenCalledTimes(1);
    await c.answer({ choice: null, remember: false });
    c.close();
    expect(c.o.ask).toHaveBeenCalledTimes(2);
  });

  it('quitting while the question is open: the answer does nothing more', async () => {
    let state = base;
    const c = closer(() => state);
    c.close();
    state = { ...base, quitting: true };
    await c.answer({ choice: 'tray', remember: true });
    expect(c.o.hide).not.toHaveBeenCalled();
    expect(c.o.remember).not.toHaveBeenCalled();
  });

  it('最小化到托盘 set: hidden without asking; 退出 set or quitting: closes', () => {
    let state: CloseState = { ...base, closeWindow: 'tray' };
    const c = closer(() => state);
    expect(c.close()).toBe(true);
    expect(c.o.ask).not.toHaveBeenCalled();
    expect(c.o.hide).toHaveBeenCalledTimes(1);
    state = { ...base, closeWindow: 'quit' };
    expect(c.close()).toBe(false);
    state = { ...base, quitting: true };
    expect(c.close()).toBe(false);
  });

  it('the notification names the app and the tray', () => {
    expect(trayHint('Spica')).toEqual({ title: 'Spica', content: 'Spica 已最小化到托盘，仍在运行。点托盘图标打开，右键图标可以退出。' });
  });
});

describe('asking through the page', () => {
  function asker(ready = true) {
    const calls: string[] = [];
    const a = closeAsker({
      pageReady: () => ready,
      reveal: () => calls.push('reveal'),
      send: () => calls.push('send'),
      fallback: async () => {
        calls.push('fallback');
        return { choice: 'quit', remember: false };
      },
    });
    return { a, calls };
  }

  it('the window comes to the front, then the page is asked; its answer is the answer', async () => {
    const { a, calls } = asker();
    const p = a.ask();
    expect(calls).toEqual(['reveal', 'send']);
    a.answer({ choice: 'tray', remember: true });
    await expect(p).resolves.toEqual({ choice: 'tray', remember: true });
  });

  it('closing the dialog, or junk: no choice', async () => {
    const { a } = asker();
    const p1 = a.ask();
    a.answer({ choice: null });
    await expect(p1).resolves.toEqual({ choice: null, remember: false });
    a.pageGone(); // nothing asked: nothing to do
    expect(parseCloseAnswer({ choice: 'hide', remember: true })).toEqual({ choice: null, remember: false });
    expect(parseCloseAnswer('quit')).toEqual({ choice: null, remember: false });
  });

  it('a page that goes before answering: asked over with the message box', async () => {
    const { a, calls } = asker();
    const p = a.ask();
    a.pageGone();
    await expect(p).resolves.toEqual({ choice: 'quit', remember: false });
    expect(calls).toEqual(['reveal', 'send', 'fallback']);
    a.answer({ choice: 'tray', remember: false }); // a late answer is dropped
  });

  it('a page not ready: the message box instead, the page is not asked', async () => {
    const { a, calls } = asker(false);
    await expect(a.ask()).resolves.toEqual({ choice: 'quit', remember: false });
    expect(calls).toEqual(['fallback']);
  });

  it('the page and the fallback box put the same question', () => {
    expect(closePrompt('Spica').message).toBe(CLOSE_QUESTION);
  });
});
