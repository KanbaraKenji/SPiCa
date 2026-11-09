// Main process of the Spica desktop shell.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { IpcChannel, type AgentApi, type AppInfo } from '@spica/protocol';
import { DesktopChannel } from '../shared/ipc';
import { deriveTokens, resolveSkin, schemeOf } from '../shared/skin';
import { clampZoom, DEFAULT_ZOOM, stepZoom } from '../shared/zoom';
import type { ShellSettings } from '../shared/settings';
import type { ShellState } from '../shared/bridge';
import { createBackend } from './backend';
import { SettingsStore } from './settings-store';
import { captureOnce, runShots } from './shots';

const APP_NAME = 'Spica';
/** Title bar height in CSS px at 100% zoom; must match `--spica-titlebar-h` in the renderer. */
const TITLEBAR_HEIGHT = 40;

// Dev-only switches, used by scripts and screenshots:
//   SPICA_THEME=dark|light   force the color scheme instead of following the system
//   SPICA_CAPTURE=<file.png> render the window once, save a PNG and quit
//   SPICA_SHOTS=<dir>        render the screenshot matrix into <dir> and quit
const forcedTheme = process.env.SPICA_THEME;
const capturePath = process.env.SPICA_CAPTURE;
const shotsDir = process.env.SPICA_SHOTS;
const automated = Boolean(capturePath || shotsDir);

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('dev.spica.desktop');
// Screenshots must not read or change the user's own settings.
//   SPICA_USER_DATA=<dir>    use another settings folder (manual checks without touching your own)
if (process.env.SPICA_USER_DATA) app.setPath('userData', process.env.SPICA_USER_DATA);
else if (automated) app.setPath('userData', mkdtempSync(join(tmpdir(), 'spica-shots-')));

if (forcedTheme === 'dark' || forcedTheme === 'light') nativeTheme.themeSource = forcedTheme;

const backend = createBackend({ speed: automated ? 0 : 1 });
const settings = new SettingsStore(app.getPath('userData'), { persist: !automated });
if (forcedTheme === 'dark' || forcedTheme === 'light') settings.update({ skin: forcedTheme });

const AGENT_METHODS = new Set<keyof AgentApi>([
  'createSession',
  'listSessions',
  'getSession',
  'getMessages',
  'getPending',
  'send',
  'steer',
  'answer',
  'confirm',
  'abort',
  'exportTraces',
]);

let mainWindow: BrowserWindow | undefined;

function chromeColors(s: ShellSettings): { bg: string; chrome: string; ink: string } {
  const skin = resolveSkin(s.skin, nativeTheme.shouldUseDarkColors, s.customSkins);
  const t = deriveTokens(skin);
  return { bg: t['--spica-bg'] ?? skin.bg, chrome: t['--spica-chrome'] ?? skin.bg, ink: t['--spica-muted'] ?? '#888888' };
}

/** Keeps native parts (window background, caption buttons, scrollbars) in step with the skin. */
function syncNativeChrome(win: BrowserWindow, s: ShellSettings): void {
  if (!forcedTheme) {
    const skin = resolveSkin(s.skin, nativeTheme.shouldUseDarkColors, s.customSkins);
    // Built-in choices follow the system; a custom skin carries its own scheme.
    const wanted = s.skin === 'system' ? 'system' : schemeOf(skin.bg);
    if (nativeTheme.themeSource !== wanted) nativeTheme.themeSource = wanted;
  }
  const c = chromeColors(s);
  win.setBackgroundColor(c.bg);
  if (process.platform === 'win32') {
    win.setTitleBarOverlay({ color: c.chrome, symbolColor: c.ink, height: Math.round(TITLEBAR_HEIGHT * s.zoom) });
  }
}

function applyZoom(win: BrowserWindow, factor: number): void {
  const zoom = clampZoom(factor);
  win.webContents.setZoomFactor(zoom);
  if (settings.get().zoom !== zoom) settings.update({ zoom });
}

function createMainWindow(): BrowserWindow {
  const s = settings.get();
  const c = chromeColors(s);
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 360,
    title: APP_NAME,
    show: false,
    backgroundColor: c.bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.chrome, symbolColor: c.ink, height: Math.round(TITLEBAR_HEIGHT * s.zoom) },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: s.zoom,
      spellcheck: false,
    },
  });

  if (!automated) win.once('ready-to-show', () => win.show());

  // Ctrl+wheel. We own the zoom level (Electron's own per-origin zoom is not persisted).
  win.webContents.on('zoom-changed', (_e, direction) => applyZoom(win, stepZoom(settings.get().zoom, direction)));
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(settings.get().zoom));
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (ctrl && !input.alt) {
      const key = input.key;
      if (key === '0' || input.code === 'Numpad0') {
        event.preventDefault();
        applyZoom(win, DEFAULT_ZOOM);
      } else if (key === '=' || key === '+' || input.code === 'NumpadAdd') {
        event.preventDefault();
        applyZoom(win, stepZoom(settings.get().zoom, 'in'));
      } else if (key === '-' || key === '_' || input.code === 'NumpadSubtract') {
        event.preventDefault();
        applyZoom(win, stepZoom(settings.get().zoom, 'out'));
      }
    }
    if (!app.isPackaged && input.key === 'F12') win.webContents.toggleDevTools();
  });

  // Links open in the user's browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

function shellState(): ShellState {
  return { settings: settings.get(), systemDark: nativeTheme.shouldUseDarkColors };
}

ipcMain.handle(IpcChannel.AppInfo, (): AppInfo => ({ name: APP_NAME, version: app.getVersion() }));
ipcMain.handle(DesktopChannel.GetShellState, () => shellState());
ipcMain.handle(DesktopChannel.UpdateSettings, (_e, patch: unknown) => {
  const p = patch && typeof patch === 'object' ? (patch as Partial<ShellSettings>) : {};
  const next = settings.update(p);
  if (mainWindow && typeof p.zoom === 'number') mainWindow.webContents.setZoomFactor(next.zoom);
  return next;
});
ipcMain.handle(DesktopChannel.Agent, async (_e, method: unknown, args: unknown) => {
  if (typeof method !== 'string' || !AGENT_METHODS.has(method as keyof AgentApi)) {
    throw new Error(`不支持的操作：${String(method)}`);
  }
  const fn = backend[method as keyof AgentApi] as (...a: unknown[]) => Promise<unknown>;
  return fn.apply(backend, Array.isArray(args) ? args : []);
});

ipcMain.handle(DesktopChannel.OpenFile, async (_e, sessionId: unknown, path: unknown): Promise<string | null> => {
  if (typeof sessionId !== 'string' || typeof path !== 'string' || !path) return '文件路径不对。';
  const session = await backend.getSession(sessionId);
  const full = isAbsolute(path) ? path : resolvePath(session?.cwd || app.getPath('home'), path);
  if (!existsSync(full)) return `找不到文件：${full}`;
  const error = await shell.openPath(full);
  return error ? `打不开这个文件：${error}` : null;
});

backend.onEvent((event) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(DesktopChannel.AgentEvent, event);
});
settings.onChange((s) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  syncNativeChrome(mainWindow, s);
  mainWindow.webContents.send(DesktopChannel.SettingsChanged, s);
});
nativeTheme.on('updated', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  syncNativeChrome(mainWindow, settings.get());
  mainWindow.webContents.send(DesktopChannel.SettingsChanged, settings.get());
});

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  mainWindow = createMainWindow();
  syncNativeChrome(mainWindow, settings.get());
  if (shotsDir) void runShots(mainWindow, settings, shotsDir);
  else if (capturePath) void captureOnce(mainWindow, capturePath);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
  });
});

app.on('before-quit', () => {
  settings.flush();
  backend.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
