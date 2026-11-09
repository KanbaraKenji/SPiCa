// Main process of the Spica desktop shell.
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, shell } from 'electron';
import { IpcChannel, type AgentApi, type AppInfo } from '@spica/protocol';
import { DesktopChannel } from '../shared/ipc';
import { deriveTokens, resolveSkin, schemeOf } from '../shared/skin';
import { clampZoom, DEFAULT_ZOOM, stepZoom } from '../shared/zoom';
import type { ShellSettings } from '../shared/settings';
import type { ProviderList, ShellState } from '../shared/bridge';
import type { ProviderDraft, ProviderView } from '../shared/providers';
import { ProviderStore } from './providers/store';
import { createFakeTester } from './providers/tester';
import { chooseBackend, createBackend } from './backend';
import { readModelEnv } from './backend/model-env';
import { SettingsStore } from './settings-store';
import { captureOnce, runShots } from './shots';

const APP_NAME = 'Spica';
/** Title bar height in CSS px at 100% zoom; must match `--spica-titlebar-h` in the renderer. */
const TITLEBAR_HEIGHT = 40;

// Dev-only switches, used by scripts and screenshots:
//   SPICA_THEME=dark|light   force the color scheme instead of following the system
//   SPICA_CAPTURE=<file.png> render the window once, save a PNG and quit
//   SPICA_SHOTS=<dir>        render the screenshot matrix into <dir> and quit
//   SPICA_BACKEND=fake|core  pick the backend (default: the real core; screenshots use the fake)
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

// Development model settings: the repository's .env.local, read here and nowhere else.
// Screenshots never read it, so no local model shows up in committed images.
const modelEnv = app.isPackaged || automated ? {} : readModelEnv(resolvePath(app.getAppPath(), '../../.env.local'));
const backendKind = chooseBackend({ requested: process.env.SPICA_BACKEND, automated });
const workDir = join(app.getPath('documents'), 'Spica');
if (backendKind === 'core') mkdirSync(workDir, { recursive: true });
const backend = createBackend(backendKind, {
  fake: { speed: automated ? 0 : 1 },
  env: modelEnv,
  cwd: workDir,
  dbPath: join(app.getPath('userData'), 'spica.db'),
});
console.log(`[spica] backend: ${backendKind === 'core' ? 'agent core' : 'fake (demo data)'}`);
const settings = new SettingsStore(app.getPath('userData'), { persist: !automated });
const providers = new ProviderStore(
  app.getPath('userData'),
  {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
  },
  () => envProviders().map((p) => p.id),
);
const testConnection = createFakeTester({ delayMs: automated ? 0 : 700 });
let providerProblems: Record<string, string> = {};

/** Models from the developer's .env.local, shown read-only on the settings page. */
function envProviders(): ProviderView[] {
  const base = { strongModel: '', tokenUrl: '', clientId: '', scope: '', maxConcurrent: null, requestsPerMinute: null, hasSecret: true, isDefault: false, readOnly: true };
  const out: ProviderView[] = [];
  if (modelEnv.openai) out.push({ ...base, id: 'openai', kind: 'openai', name: '开发用模型（.env.local）', baseUrl: modelEnv.openai.baseUrl, model: modelEnv.openai.model });
  if (modelEnv.anthropic) out.push({ ...base, id: 'anthropic', kind: 'anthropic', name: '开发用模型（.env.local）', baseUrl: '', model: modelEnv.anthropic.model });
  return out;
}

function providerList(): ProviderList {
  const def = providers.defaultId();
  const env = envProviders().map((p) => ({ ...p, isDefault: p.id === def }));
  return { items: [...env, ...providers.list()], problems: providerProblems };
}

/** Hands saved providers to the backend; remembers which ones it could not use. */
function applyProviders(): void {
  if (!backend.configure) return;
  const problems = backend.configure(providers.resolved(), providers.defaultId());
  providerProblems = Object.fromEntries(problems.map((p) => [p.id, p.reason]));
}
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
  'renameSession',
  'resume',
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

/** Window / taskbar icon, matched to the Windows taskbar's own light or dark color. */
function windowIcon(): Electron.NativeImage | undefined {
  const variant = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'dark' : 'light';
  const file = join(app.getAppPath(), 'resources', 'branding', 'png', `spica-win-${variant}.png`);
  if (!existsSync(file)) return undefined;
  const image = nativeImage.createFromPath(file);
  return image.isEmpty() ? undefined : image;
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
    ...(windowIcon() ? { icon: windowIcon() } : {}),
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
  return { settings: settings.get(), systemDark: nativeTheme.shouldUseDarkColors, demo: backendKind === 'fake' && !automated, automated };
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

ipcMain.on(DesktopChannel.Zoom, (_e, step: unknown) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (step === 'reset') applyZoom(mainWindow, DEFAULT_ZOOM);
  else if (step === 'in' || step === 'out') applyZoom(mainWindow, stepZoom(settings.get().zoom, step));
});

ipcMain.handle(DesktopChannel.ListProviders, () => providerList());
ipcMain.handle(DesktopChannel.SaveProvider, (_e, draft: ProviderDraft) => {
  providers.save(draft);
  applyProviders();
  return providerList();
});
ipcMain.handle(DesktopChannel.DeleteProvider, (_e, id: string) => {
  providers.remove(id);
  applyProviders();
  return providerList();
});
ipcMain.handle(DesktopChannel.SetDefaultProvider, (_e, id: string) => {
  providers.setDefault(id);
  applyProviders();
  return providerList();
});
ipcMain.handle(DesktopChannel.TestProvider, (_e, draft: ProviderDraft) =>
  testConnection(draft, draft.id ? providers.secretOf(draft.id) : undefined),
);

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
  const icon = windowIcon();
  if (icon) mainWindow.setIcon(icon);
  syncNativeChrome(mainWindow, settings.get());
  mainWindow.webContents.send(DesktopChannel.SettingsChanged, settings.get());
});

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  applyProviders();
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
