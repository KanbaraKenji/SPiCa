// A dialog in a small window of its own (main/app-dialog-window.ts), for when the main window's page cannot show
// one: its own page (renderer/dialog.html, no React, none of the app's page code) and its own page process, so it
// shows while the main window's page is gone. It looks like the page's dialogs (ui/Dialog.tsx ConfirmDialog,
// ui/CloseDialog.tsx): the colors come from the skin, worked out in main and passed in with the text.
// Shared by main, the dialog's preload (preload/dialog.ts) and its page (renderer/dialog/main.ts).

export const DialogChannel = {
  /** Page → main: drawn, with its height in CSS pixels; main sizes the window to it and shows it. */
  Ready: 'spica-dialog:ready',
  /** Page → main: the button clicked (index into buttons) and the checkbox. */
  Answer: 'spica-dialog:answer',
} as const;

export interface DialogButton {
  label: string;
  /** The main button: the skin's accent, focused at first, Enter. One per dialog. */
  primary?: boolean;
}

/** The skin's colors the dialog uses (the page's CSS variables of the same names). */
export const DIALOG_TOKENS = [
  '--spica-raised',
  '--spica-ink',
  '--spica-muted',
  '--spica-accent',
  '--spica-on-accent',
  '--spica-control',
  '--spica-control-hover',
  '--spica-border-strong',
] as const;

export interface DialogSpec {
  title: string;
  /** Lines under the title, each its own paragraph (.dialog-detail). */
  detail: string[];
  /** In the order shown, left to right (the page's dialogs put the main button last). */
  buttons: DialogButton[];
  /** A checkbox above the buttons (unticked), e.g. 记住我的选择. */
  check?: string;
  /** dark or light: the native parts (checkbox, focus ring) follow it. */
  scheme: 'dark' | 'light';
  tokens: Partial<Record<(typeof DIALOG_TOKENS)[number], string>>;
}

/** What the user did: the button (index into buttons), or null when the dialog was closed (Alt+F4) without one. */
export interface DialogAnswer {
  button: number | null;
  checked: boolean;
}

/** The colors for the dialog from the skin's tokens (shared/skin.ts deriveTokens). */
export function dialogTokens(all: Record<string, string>): DialogSpec['tokens'] {
  const out: DialogSpec['tokens'] = {};
  for (const name of DIALOG_TOKENS) if (all[name]) out[name] = all[name];
  return out;
}

/** Reads a spec handed to the page (the query's spec); anything else is null. */
export function parseDialogSpec(raw: string | null): DialogSpec | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DialogSpec>;
    if (typeof v.title !== 'string' || !Array.isArray(v.buttons) || v.buttons.length === 0) return null;
    return {
      title: v.title,
      detail: Array.isArray(v.detail) ? v.detail.filter((d): d is string => typeof d === 'string') : [],
      buttons: v.buttons.filter((b) => b && typeof b.label === 'string').map((b) => ({ label: b.label, ...(b.primary ? { primary: true } : {}) })),
      ...(typeof v.check === 'string' ? { check: v.check } : {}),
      scheme: v.scheme === 'light' ? 'light' : 'dark',
      tokens: v.tokens && typeof v.tokens === 'object' ? v.tokens : {},
    };
  } catch {
    return null;
  }
}
