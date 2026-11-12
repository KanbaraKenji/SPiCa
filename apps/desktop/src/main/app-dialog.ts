// Asking in the small dialog window (shared/app-dialog.ts; the window itself in main/app-dialog-window.ts), with
// the Windows message box as the fallback of the fallback: when the window cannot be made, its page fails to load or
// goes before an answer, or it is not drawn within DIALOG_SHOW_MS.
import type { DialogAnswer, DialogSpec } from '../shared/app-dialog';
import { deriveTokens, schemeOf, type Skin } from '../shared/skin';
import { dialogTokens } from '../shared/app-dialog';

/** The small window drawn within this long, else the message box. */
export const DIALOG_SHOW_MS = 5_000;

/** The dialog window as the runner sees it (a BrowserWindow in app-dialog-window.ts, a fake in tests). */
export interface DialogWindow {
  /** The page has drawn the dialog; its height in CSS pixels. */
  onReady(cb: (height: number) => void): void;
  /** The button (null for the × at the top right), the checkbox, the choice (null without choices). */
  onAnswer(cb: (button: number | null, checked: boolean, choice: number | null) => void): void;
  /** Its page failed to load or its page process went. */
  onFailed(cb: (why: string) => void): void;
  /** The window closed (Alt+F4, or by us). */
  onClosed(cb: () => void): void;
  /** Sizes the window to the page's height and shows it. */
  show(height: number): void;
  close(): void;
}

/**
 * Runs one dialog window: resolves with the answer (closed after it was shown: no button), rejects when it fails
 * before an answer or is not drawn within showMs.
 */
export function runDialog(w: DialogWindow, showMs = DIALOG_SHOW_MS, timer: (fn: () => void, ms: number) => unknown = setTimeout): Promise<DialogAnswer> {
  return new Promise((resolve, reject) => {
    let shown = false;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const fail = (why: string) =>
      finish(() => {
        w.close();
        reject(new Error(why));
      });
    timer(() => {
      if (!shown) fail(`not shown within ${showMs / 1000} s`);
    }, showMs);
    w.onReady((height) => {
      if (settled || shown) return;
      shown = true;
      w.show(height);
    });
    w.onAnswer((button, checked, choice) =>
      finish(() => {
        resolve({ button, checked, choice });
        w.close();
      }),
    );
    w.onFailed((why) => fail(why));
    w.onClosed(() => {
      if (shown) finish(() => resolve({ button: null, checked: false, choice: null }));
      else fail('closed before it was shown');
    });
  });
}

export interface AskOptions {
  /** Opens the small window and runs it (runDialog); throws or rejects when it cannot. */
  open(): Promise<DialogAnswer>;
  /** The Windows message box. */
  fallback(): Promise<DialogAnswer>;
  warn(line: string): void;
}

/** Asks in the small window; when that fails, says so in the log and asks with the message box. */
export async function askDialog(o: AskOptions): Promise<DialogAnswer> {
  try {
    return await o.open();
  } catch (e) {
    o.warn(`[spica] dialog window: ${e instanceof Error ? e.message : String(e)}; asking with the message box`);
    return o.fallback();
  }
}

/** The skin's scheme and colors for a dialog. */
export function dialogLook(skin: Skin): Pick<DialogSpec, 'scheme' | 'tokens'> {
  return { scheme: schemeOf(skin.bg), tokens: dialogTokens(deriveTokens(skin)) };
}

/** 界面出错: the third loss of the page within a minute (main/page-recovery.ts). Button 1 (重新加载) is the main one. */
export function crashDialog(appName: string, look: Pick<DialogSpec, 'scheme' | 'tokens'>): DialogSpec {
  return {
    title: '界面出错',
    detail: [`界面一分钟内连续出错，已停止自动重新加载。重新加载会回到刚才的对话；退出 ${appName} 会结束正在进行的任务。`],
    buttons: [{ label: `退出 ${appName}` }, { label: '重新加载', primary: true }],
    ...look,
  };
}

/** 重新加载 in crashDialog's answer; any other button, or the dialog closed, is 退出 (as the message box's cancelId was). */
export function crashAnswer(a: DialogAnswer): boolean {
  return a.button === 1;
}

/** The same question as a Windows message box (the fallback): the main button first (its default), then the rest. */
export function messageBoxFor(
  spec: DialogSpec,
  o: { type: 'none' | 'info' | 'error' | 'question' | 'warning'; appName: string; /** The button closing the box counts as. */ cancel: number },
): { options: { type: typeof o.type; title: string; message: string; detail?: string; buttons: string[]; defaultId: number; cancelId: number; noLink: true; checkboxLabel?: string; checkboxChecked?: boolean }; answer(response: number, checked: boolean): DialogAnswer } {
  const main = Math.max(0, spec.buttons.findIndex((b) => b.primary));
  const order = [main, ...spec.buttons.map((_, i) => i).filter((i) => i !== main)];
  return {
    options: {
      type: o.type,
      title: o.appName,
      message: spec.title,
      ...(spec.detail.length ? { detail: spec.detail.join('\n') } : {}),
      buttons: order.map((i) => spec.buttons[i]!.label),
      defaultId: 0,
      cancelId: Math.max(0, order.indexOf(o.cancel)),
      noLink: true,
      ...(spec.check ? { checkboxLabel: spec.check, checkboxChecked: false } : {}),
    },
    answer: (response, checked) => ({ button: order[response] ?? null, checked: Boolean(spec.check) && checked, choice: null }),
  };
}
