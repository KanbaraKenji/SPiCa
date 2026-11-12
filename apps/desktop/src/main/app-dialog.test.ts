import { describe, expect, it } from 'vitest';
import { askDialog, crashAnswer, crashDialog, dialogLook, messageBoxFor, runDialog, type DialogWindow } from './app-dialog';
import { parseDialogSpec, type DialogAnswer } from '../shared/app-dialog';
import { DARK_SKIN, LIGHT_SKIN } from '../shared/skin';

function fakeWindow() {
  const cb: { ready?: (h: number) => void; answer?: (b: number, c: boolean) => void; failed?: (w: string) => void; closed?: () => void } = {};
  const calls: string[] = [];
  const w: DialogWindow = {
    onReady: (f) => (cb.ready = f),
    onAnswer: (f) => (cb.answer = f),
    onFailed: (f) => (cb.failed = f),
    onClosed: (f) => (cb.closed = f),
    show: (h) => calls.push(`show ${h}`),
    close: () => {
      calls.push('close');
      cb.closed?.();
    },
  };
  let fire: () => void = () => undefined;
  const timer = (fn: () => void) => (fire = fn);
  return { w, cb, calls, timer, timeout: () => fire() };
}

describe('the dialog window', () => {
  it('is shown at the height its page drew, answers with the button and the checkbox, and closes', async () => {
    const f = fakeWindow();
    const p = runDialog(f.w, 5000, f.timer);
    f.cb.ready!(180);
    f.cb.answer!(1, true);
    await expect(p).resolves.toEqual({ button: 1, checked: true });
    expect(f.calls).toEqual(['show 180', 'close']);
  });

  it('closed after it was shown (Alt+F4) answers no button', async () => {
    const f = fakeWindow();
    const p = runDialog(f.w, 5000, f.timer);
    f.cb.ready!(180);
    f.cb.closed!();
    await expect(p).resolves.toEqual({ button: null, checked: false });
  });

  it('fails when its page goes, its page does not load, or it is not drawn in time', async () => {
    for (const end of ['failed', 'timeout', 'closed'] as const) {
      const f = fakeWindow();
      const p = runDialog(f.w, 5000, f.timer);
      if (end === 'failed') f.cb.failed!('page process gone (killed, exit code 1)');
      if (end === 'timeout') f.timeout();
      if (end === 'closed') f.cb.closed!();
      await expect(p).rejects.toThrow(end === 'failed' ? 'page process gone' : end === 'timeout' ? 'not shown within 5 s' : 'closed before');
    }
  });

  it('its page going after it was shown, before an answer, fails too', async () => {
    const f = fakeWindow();
    const p = runDialog(f.w, 5000, f.timer);
    f.cb.ready!(180);
    f.cb.failed!('page process gone (crashed, exit code 5)');
    await expect(p).rejects.toThrow('page process gone');
    expect(f.calls).toContain('close');
  });
});

describe('asking: the small window, else the message box', () => {
  const answer: DialogAnswer = { button: 1, checked: false };

  it('answers from the small window without the message box', async () => {
    const seen: string[] = [];
    const a = await askDialog({ open: () => Promise.resolve(answer), fallback: () => (seen.push('box'), Promise.resolve({ button: 0, checked: false })), warn: (l) => seen.push(l) });
    expect(a).toEqual(answer);
    expect(seen).toEqual([]);
  });

  it('falls back to the message box when the small window fails or cannot be made, and says so', async () => {
    for (const open of [() => Promise.reject(new Error('not shown within 5 s')), () => { throw new Error('cannot create window'); }]) {
      const seen: string[] = [];
      const a = await askDialog({ open, fallback: () => (seen.push('box'), Promise.resolve(answer)), warn: (l) => seen.push(l) });
      expect(a).toEqual(answer);
      expect(seen[1]).toBe('box');
      expect(seen[0]).toMatch(/^\[spica\] dialog window: (not shown within 5 s|cannot create window); asking with the message box$/);
    }
  });
});

describe('界面出错', () => {
  const spec = crashDialog('Spica', dialogLook(DARK_SKIN));

  it('has 重新加载 as the main button, last as in the page dialogs', () => {
    expect(spec.title).toBe('界面出错');
    expect(spec.buttons).toEqual([{ label: '退出 Spica' }, { label: '重新加载', primary: true }]);
    expect(crashAnswer({ button: 1, checked: false })).toBe(true);
    expect(crashAnswer({ button: 0, checked: false })).toBe(false);
    // Closed without a choice: 退出, as the message box's cancel was.
    expect(crashAnswer({ button: null, checked: false })).toBe(false);
  });

  it('as a message box: 重新加载 first and default, closing it is 退出', () => {
    const box = messageBoxFor(spec, { type: 'error', appName: 'Spica', cancel: 0 });
    expect(box.options).toMatchObject({ type: 'error', title: 'Spica', message: '界面出错', buttons: ['重新加载', '退出 Spica'], defaultId: 0, cancelId: 1, noLink: true });
    expect(crashAnswer(box.answer(0, false))).toBe(true);
    expect(crashAnswer(box.answer(1, false))).toBe(false);
  });

  it("takes the skin's colors: dark and light", () => {
    expect(dialogLook(DARK_SKIN)).toMatchObject({ scheme: 'dark', tokens: { '--spica-raised': '#303030', '--spica-ink': '#efefef', '--spica-accent': '#62a9ff' } });
    expect(dialogLook(LIGHT_SKIN)).toMatchObject({ scheme: 'light', tokens: { '--spica-raised': '#ffffff', '--spica-ink': '#191919', '--spica-accent': '#2f7de1' } });
  });
});

describe('the spec handed to the page', () => {
  it('reads back what main sent, with an optional checkbox', () => {
    const spec = { ...crashDialog('Spica', dialogLook(LIGHT_SKIN)), check: '记住我的选择' };
    expect(parseDialogSpec(JSON.stringify(spec))).toEqual(spec);
  });

  it('refuses anything without a title or buttons', () => {
    expect(parseDialogSpec(null)).toBeNull();
    expect(parseDialogSpec('{')).toBeNull();
    expect(parseDialogSpec(JSON.stringify({ title: 'x', buttons: [] }))).toBeNull();
  });
});
