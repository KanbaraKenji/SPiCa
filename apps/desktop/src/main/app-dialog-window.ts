// The small dialog window (shared/app-dialog.ts): a BrowserWindow of its own with its own page (renderer/dialog.html)
// and page process, so it shows while the main window's page is gone. No title bar, not resizable, a modal child of
// the main window (no taskbar button of its own), centred on it. On Windows 11 the window's own rounded corners and
// shadow stand in for the page dialog's (the frameless window keeps them; a transparent window would lose them).
import { BrowserWindow, app, screen } from 'electron';
import { join } from 'node:path';
import { DialogChannel, type DialogAnswer, type DialogSpec } from '../shared/app-dialog';
import { runDialog, type DialogWindow } from './app-dialog';

/** The page dialog's width (styles.css .dialog: min(400px, 100%)), in CSS pixels, when the spec gives none. */
const WIDTH = 400;

/** Opens the dialog over parent and resolves with the answer; rejects when the window cannot be shown (app-dialog.ts runDialog). */
export function openDialogWindow(parent: BrowserWindow, spec: DialogSpec, zoom: number, showMs?: number): Promise<DialogAnswer> {
  const width = spec.width ?? WIDTH;
  const win = new BrowserWindow({
    parent,
    modal: true,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    width: Math.round(width * zoom),
    height: Math.round(160 * zoom),
    backgroundColor: spec.tokens['--spica-raised'] ?? (spec.scheme === 'dark' ? '#303030' : '#ffffff'),
    title: spec.title,
    webPreferences: {
      preload: join(__dirname, '../preload/dialog.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: zoom,
      spellcheck: false,
    },
  });
  win.removeMenu();
  const wc = win.webContents;
  const handle: DialogWindow = {
    onReady: (cb) => wc.ipc.on(DialogChannel.Ready, (_e, h: unknown) => cb(typeof h === 'number' && h > 0 ? h : 160)),
    onAnswer: (cb) =>
      wc.ipc.on(DialogChannel.Answer, (_e, b: unknown, c: unknown, k: unknown) =>
        cb(typeof b === 'number' && b >= 0 && b < spec.buttons.length ? b : null, c === true, spec.choices && typeof k === 'number' && k >= 0 && k < spec.choices.options.length ? k : null),
      ),
    onFailed: (cb) => {
      wc.on('did-fail-load', (_e, code, desc, _url, mainFrame) => {
        if (mainFrame && code !== -3) cb(`page failed to load (${code} ${desc})`);
      });
      wc.on('render-process-gone', (_e, d) => cb(`page process gone (${d.reason}, exit code ${d.exitCode})`));
    },
    onClosed: (cb) => win.on('closed', cb),
    show: (height) => {
      if (win.isDestroyed()) return;
      const w = Math.round(width * zoom);
      const h = Math.round(height * zoom);
      // Centred on the main window, kept on the screen it is on.
      const p = parent.isDestroyed() ? null : parent.getBounds();
      const area = screen.getDisplayMatching(p ?? win.getBounds()).workArea;
      const cx = p ? p.x + p.width / 2 : area.x + area.width / 2;
      const cy = p ? p.y + p.height / 2 : area.y + area.height / 2;
      const x = Math.round(Math.min(Math.max(cx - w / 2, area.x), area.x + area.width - w));
      const y = Math.round(Math.min(Math.max(cy - h / 2, area.y), area.y + area.height - h));
      win.setBounds({ x, y, width: w, height: h });
      win.show();
      win.focus();
    },
    close: () => {
      if (!win.isDestroyed()) win.close();
    },
  };
  const answer = runDialog(handle, showMs);
  const query = { spec: JSON.stringify(spec) };
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) win.loadURL(`${devUrl}/dialog.html?${new URLSearchParams(query).toString()}`).catch(() => undefined);
  else win.loadFile(join(__dirname, '../renderer/dialog.html'), { query }).catch(() => undefined);
  // A failed load is told by did-fail-load (onFailed).
  return answer;
}
