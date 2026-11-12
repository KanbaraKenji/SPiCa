// A dialog in a small window of its own (main/app-dialog-window.ts), for when the main window's page cannot show
// one: its own page (renderer/dialog.html, no React, none of the app's page code) and its own page process, so it
// shows while the main window's page is gone. It looks like the page's dialogs (ui/Dialog.tsx ConfirmDialog,
// ui/CloseDialog.tsx): the colors come from the skin, worked out in main and passed in with the text.
// Shared by main, the dialog's preload (preload/dialog.ts) and its page (renderer/dialog/main.ts).

import { SYSTEM_FONT_PLAIN, SYSTEM_FONT_SEGOE, UI_FONT_FAMILY } from './ui-font';

/** The interface font stacks a dialog may be given (shared/ui-font.ts); anything else is dropped. */
const UI_FONT_STACKS = [UI_FONT_FAMILY, SYSTEM_FONT_PLAIN, SYSTEM_FONT_SEGOE];

export const DialogChannel = {
  /** Page → main: drawn, with its height in CSS pixels; main sizes the window to it and shows it. */
  Ready: 'spica-dialog:ready',
  /** Page → main: the button clicked (index into buttons; -1 for the × at the top right), the checkbox, the choice. */
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
  '--spica-hover',
  '--spica-active',
] as const;

export interface DialogSpec {
  title: string;
  /** Lines under the title, each its own paragraph (.dialog-detail). */
  detail: string[];
  /** In the order shown, left to right (the page's dialogs put the main button last). */
  buttons: DialogButton[];
  /** A checkbox (unticked), e.g. 记住我的选择: above the buttons, or beside them with checkInFoot. */
  check?: string;
  /** The checkbox at the left of the buttons' row instead of above it (CloseDialog's foot). */
  checkInFoot?: boolean;
  /** Radio buttons one under another below the lines (CloseDialog's choices): their labels and the one selected at first. */
  choices?: { options: string[]; selected: number };
  /** A × at the top right (CloseDialog's): clicking it is no choice, as closing the window is. */
  closeButton?: boolean;
  /** The box's width in CSS pixels (the page's .dialog is 400, .close-dialog 360). */
  width?: number;
  /** dark or light: the native parts (checkbox, focus ring) follow it. */
  scheme: 'dark' | 'light';
  tokens: Partial<Record<(typeof DIALOG_TOKENS)[number], string>>;
  /** 外观 › 界面字体's stack (shared/ui-font.ts); only one of those, nothing else is taken. */
  font?: string;
}

/**
 * What the user did: the button (index into buttons), or null when the dialog was closed (Alt+F4, its ×) without
 * one; the checkbox; the choice selected (index into choices.options, null without choices).
 */
export interface DialogAnswer {
  button: number | null;
  checked: boolean;
  choice: number | null;
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
      ...(v.checkInFoot === true ? { checkInFoot: true } : {}),
      ...(v.choices && Array.isArray(v.choices.options) && v.choices.options.every((o) => typeof o === 'string') && v.choices.options.length > 0
        ? { choices: { options: v.choices.options, selected: Number.isInteger(v.choices.selected) && v.choices.selected >= 0 && v.choices.selected < v.choices.options.length ? v.choices.selected : 0 } }
        : {}),
      ...(v.closeButton === true ? { closeButton: true } : {}),
      ...(typeof v.width === 'number' && v.width >= 200 && v.width <= 800 ? { width: v.width } : {}),
      scheme: v.scheme === 'light' ? 'light' : 'dark',
      tokens: v.tokens && typeof v.tokens === 'object' ? v.tokens : {},
      ...(typeof v.font === 'string' && UI_FONT_STACKS.includes(v.font) ? { font: v.font } : {}),
    };
  } catch {
    return null;
  }
}
