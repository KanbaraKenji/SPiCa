// Main process of the Spica desktop shell.
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, safeStorage, shell } from 'electron';
import { IpcChannel, type AgentApi, type AppInfo } from '@spica/protocol';
import { DesktopChannel } from '../shared/ipc';
import { deriveTokens, resolveSkin, schemeOf } from '../shared/skin';
import { clampZoom, DEFAULT_ZOOM, stepZoom } from '../shared/zoom';
import type { ShellSettings } from '../shared/settings';
import type { ProviderList, ShellState, WorkflowsState } from '../shared/bridge';
import type { ProviderDraft, ProviderView } from '../shared/providers';
import { ProviderStore } from './providers/store';
import { createFakeTester } from './providers/tester';
import { createRealTester } from './providers/real-tester';
import type { PluginService } from './plugins/types';
import { FakePluginService } from './plugins/fake';
import { UpdateService } from './update/service';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { PluginsCommand } from '../shared/plugins';
import { chooseBackend, type AgentBackend } from './backend';
import { FakeBackend } from './backend/fake';
import { ProcessBackend, type BackendStatus } from './backend/process';
import { toProviderConfig } from './backend/to-config';
import type { ProviderConfig } from '@spica/core';
import type { DesktopBackendConfig } from '../backend/config';
import { readModelEnv } from './backend/model-env';
import { SettingsStore } from './settings-store';
import { captureOnce, runShots } from './shots';

const APP_NAME = 'Spica';
/** Title bar height in CSS px at 100% zoom; must match `--spica-titlebar-h` in the renderer. */
const TITLEBAR_HEIGHT = 40;

/** Native caption buttons stop one CSS px short, so the title bar's bottom line runs under them too. */
function overlayHeight(zoom: number): number {
  return Math.floor((TITLEBAR_HEIGHT - 1) * zoom);
}

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
//   SPICA_DEV_MODELS=0       ignore .env.local (see the app as a first-time user would)
const modelEnv = app.isPackaged || automated || process.env.SPICA_DEV_MODELS === '0' ? {} : readModelEnv(resolvePath(app.getAppPath(), '../../.env.local'));
const backendKind = chooseBackend({ requested: process.env.SPICA_BACKEND, automated });
const workDir = join(app.getPath('documents'), 'Spica');
/** Where workflow files live unless the user picked another folder (设置 › 常规). */
const defaultWorkflowsDir = join(workDir, 'workflows');
if (backendKind === 'core') mkdirSync(defaultWorkflowsDir, { recursive: true });
function workflowsDir(): string {
  return settings.get().workflowsDir || defaultWorkflowsDir;
}
const pluginRoot = join(app.getPath('userData'), 'plugins');

/** Everything the core's process needs, built from the current settings at every (re)start. */
function backendConfig(): DesktopBackendConfig {
  const envConfigs: ProviderConfig[] = [];
  if (modelEnv.openai) envConfigs.push({ id: 'openai', kind: 'openai-compatible', baseUrl: modelEnv.openai.baseUrl, apiKey: modelEnv.openai.apiKey, limits: { maxConcurrent: 4, requestsPerMinute: 60 } });
  if (modelEnv.anthropic) envConfigs.push({ id: 'anthropic', kind: 'anthropic', apiKey: modelEnv.anthropic.apiKey, limits: { maxConcurrent: 2, requestsPerMinute: 30 } });
  const saved = providers.resolved();
  const def = providers.defaultId();
  const envModel: Record<string, string> = {};
  if (modelEnv.openai) envModel.openai = modelEnv.openai.model;
  if (modelEnv.anthropic) envModel.anthropic = modelEnv.anthropic.model;
  const chosen = saved.find((p) => p.id === def);
  const current = chosen ? { providerId: chosen.id, model: chosen.model } : def && envModel[def] ? { providerId: def, model: envModel[def] } : null;
  return {
    core: {
      dbPath: join(app.getPath('userData'), 'spica.db'),
      providers: [...envConfigs, ...saved.map(toProviderConfig)],
      // An empty provider id makes session creation fail; the UI then says "还没有配置模型".
      defaults: { providerId: current?.providerId ?? '', model: current?.model ?? '', maxTokens: 4096, maxTurns: 30 },
      cwd: workDir,
      locale: 'zh-CN',
      workflowsDir: workflowsDir(),
      // Mail sources come from mail plugins (they register themselves); here only on / off and the interval.
      mail: { ...settings.get().mail },
      // Development limits (see docs/design/agent-core.md §10): Anthropic 100 USD total, 2 USD per call.
      budget: { perProvider: { anthropic: { globalUsd: 100, perCallUsd: 2 } }, perRunUsd: 1 },
      // Linked into the backend entry; named here as the core expects.
      extractorModules: ['@spica/extract'],
      extensions: [
        {
          module: '@spica/desktop-host',
          options: { pluginRoot, pluginSourcesFile: join(app.getPath('userData'), 'plugin-sources.json') },
        },
      ],
    },
    current,
  };
}

function sendToWindow(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

let backendStatus: BackendStatus = { state: backendKind === 'core' ? 'starting' : 'ready' };
const backend: AgentBackend =
  backendKind === 'core'
    ? new ProcessBackend({
        entry: join(__dirname, 'backend.js'),
        config: backendConfig,
        onStatus: (s) => {
          backendStatus = s;
          sendToWindow(DesktopChannel.BackendStatus, s);
        },
        onRestarted: () => sendToWindow(DesktopChannel.BackendRestarted),
        onPluginsChanged: () => sendToWindow(DesktopChannel.PluginsChanged),
      })
    : new FakeBackend({ speed: automated ? 0 : 1 });
console.log(`[spica] backend: ${backendKind === 'core' ? 'agent core (own process)' : 'fake (demo data)'}`);
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
// Screenshots and tests never touch the network; a normal run really calls the model.
const testConnection =
  backend instanceof ProcessBackend ? createRealTester((config, model) => backend.probe(config, model)) : createFakeTester({ delayMs: automated ? 0 : 700 });
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
  'getTopSession',
  'createProject',
  'listProjects',
  'getProject',
  'listMail',
  'pollMail',
  'mailFeedback',
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
    win.setTitleBarOverlay({ color: c.chrome, symbolColor: c.ink, height: overlayHeight(s.zoom) });
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
    titleBarOverlay: { color: c.chrome, symbolColor: c.ink, height: overlayHeight(s.zoom) },
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
  const fn = backend[method as keyof AgentApi] as ((...a: unknown[]) => Promise<unknown>) | undefined;
  // Name the missing method, so a backend that lags behind the shell is easy to spot.
  if (!fn) throw new Error(`这个版本还不支持这个操作（${method}）。`);
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

// Updates and announcements. The source is the user's setting, else the
// installer's deploy.json (a company sets it when packaging), else none.
function deploySource(): string {
  const file = app.isPackaged ? join(process.resourcesPath, 'deploy.json') : join(app.getAppPath(), 'deploy.json');
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as { updateSource?: unknown };
    return typeof v.updateSource === 'string' ? v.updateSource.trim() : '';
  } catch {
    return '';
  }
}
const deployDefault = automated ? '' : deploySource();
const updates = new UpdateService({
  currentVersion: app.getVersion(),
  packaged: app.isPackaged,
  portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
  downloadsDir: join(app.getPath('userData'), 'updates'),
  getSource: () => {
    const own = settings.get().updateSource;
    return own ? { source: own, fromDeploy: false } : { source: deployDefault, fromDeploy: Boolean(deployDefault) };
  },
  fetch: (url) => net.fetch(url),
  launchInstaller: (path) => {
    // Per-user NSIS installer: silent, then it starts the new version itself.
    const child = spawn(path, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    app.quit();
  },
});
updates.onChange((s) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(DesktopChannel.UpdateChanged, s);
});
ipcMain.handle(DesktopChannel.Update, async (_e, op: unknown) => {
  if (op === 'check') return updates.check();
  if (op === 'install') updates.install();
  return updates.state;
});

async function refreshNotices(): Promise<void> {
  const list = await updates.notices();
  if (list) settings.update({ noticesCache: list });
}
let lastSource = settings.get().updateSource;
settings.onChange((s) => {
  if (s.updateSource === lastSource) return;
  lastSource = s.updateSource;
  updates.reset();
  void updates.check();
  void refreshNotices();
});

// Mail and the workflow folder change in the running core (its configure): no restart.
let lastMail = JSON.stringify(settings.get().mail);
let lastWorkflowsDir = workflowsDir();
settings.onChange((s) => {
  if (!(backend instanceof ProcessBackend)) return;
  const mail = JSON.stringify(s.mail);
  if (mail !== lastMail) {
    lastMail = mail;
    void backend.apply({ mail: { ...s.mail } }).catch(() => undefined);
  }
  const dir = workflowsDir();
  if (dir !== lastWorkflowsDir) {
    lastWorkflowsDir = dir;
    workflowsApplied = backend.apply({ workflowsDir: dir }).catch(() => undefined);
  }
});
/** The last workflow folder change, so the settings page reads the new folder's result. */
let workflowsApplied: Promise<unknown> = Promise.resolve();

ipcMain.handle(DesktopChannel.Workflows, async (_e, op: unknown): Promise<WorkflowsState> => {
  const dir = workflowsDir();
  let message = '';
  if (op === 'reload' && backend instanceof ProcessBackend) workflowsApplied = backend.apply({ workflowsDir: dir }).catch(() => undefined);
  await workflowsApplied;
  if (op === 'open') {
    if (dir === defaultWorkflowsDir) mkdirSync(dir, { recursive: true });
    const err = existsSync(dir) ? await shell.openPath(dir) : '文件夹不存在';
    if (err) message = `打不开这个文件夹：${err}`;
  }
  if (!(backend instanceof ProcessBackend)) return { dir, names: ['产品开发（示例）'], problems: [], ...(message ? { message } : {}) };
  try {
    const w = await backend.workflows();
    return { dir, names: w.names, problems: w.errors.map(workflowProblem), ...(message ? { message } : {}) };
  } catch (err) {
    return { dir, names: [], problems: [], message: message || friendly(err) };
  }
});

/** The core's workflow loading errors, in words. */
function workflowProblem(raw: string): string {
  const folder = /^workflows folder (.+?): .*ENOENT/.exec(raw);
  if (folder) return `找不到这个文件夹：${folder[1]}`;
  const json = /^workflow (.+?): not valid JSON/.exec(raw);
  if (json) return `${json[1]} 不是有效的 JSON，没有读进来。`;
  const dup = /^workflow (.+?): id "(.+?)" is already defined/.exec(raw);
  if (dup) return `${dup[1]}：编号「${dup[2]}」和别的工作流重复，没有读进来。`;
  const other = /^workflow (.+?): (.*)$/.exec(raw);
  if (other) return `${other[1]} 没有读进来：${other[2]}`;
  return raw;
}

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return /[\u4e00-\u9fff]/.test(msg) ? msg : '后台没有响应，请稍后再试。';
}

ipcMain.handle(DesktopChannel.PickFolder, async (_e, title: unknown): Promise<string | null> => {
  const opts: Electron.OpenDialogOptions = { title: typeof title === 'string' && title ? title.slice(0, 60) : '选择文件夹', properties: ['openDirectory', 'createDirectory'] };
  const r = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : (r.filePaths[0] ?? null);
});

ipcMain.on(DesktopChannel.Zoom, (_e, step: unknown) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (step === 'reset') applyZoom(mainWindow, DEFAULT_ZOOM);
  else if (step === 'in' || step === 'out') applyZoom(mainWindow, stepZoom(settings.get().zoom, step));
});

// Plugins live per user (no admin rights needed): %APPDATA%\Spica\plugins.
// The plugin manager lives with the core in its process; the page talks to it over the port.
const pluginService: PluginService =
  backend instanceof ProcessBackend
    ? {
        start: async () => {},
        dispose: async () => {},
        onChange: () => () => {},
        run: async (cmd) => {
          if (cmd.op !== 'openRoot') return backend.plugins(cmd);
          mkdirSync(pluginRoot, { recursive: true });
          const err = await shell.openPath(pluginRoot);
          const r = await backend.plugins({ op: 'state' });
          return err ? { ...r, ok: false, message: `打不开这个文件夹：${err}` } : r;
        },
      }
    : new FakePluginService(pluginRoot);
ipcMain.handle(DesktopChannel.Plugins, (_e, cmd: PluginsCommand) => pluginService.run(cmd));
ipcMain.handle(DesktopChannel.BackendStatus, () => backendStatus);
ipcMain.on(DesktopChannel.BackendRetry, () => {
  if (backend instanceof ProcessBackend) backend.retry();
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
  if (backend instanceof ProcessBackend) void backend.start();
  else applyProviders();
  void pluginService.start().catch(() => {
    // Problems show up per plugin on the plugin page.
  });
  if (!automated) {
    // Announcements soon after start, then every 30 minutes; updates after 10 s, then every 4 hours.
    setTimeout(() => void refreshNotices(), 3_000);
    setInterval(() => void refreshNotices(), 30 * 60_000);
    setTimeout(() => void updates.check(), 10_000);
    setInterval(() => void updates.check(), 4 * 60 * 60_000);
  }
  mainWindow = createMainWindow();
  syncNativeChrome(mainWindow, settings.get());
  if (shotsDir) void runShots(mainWindow, settings, shotsDir);
  else if (capturePath) void captureOnce(mainWindow, capturePath);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
  });
});

let quitting = false;
app.on('before-quit', (e) => {
  settings.flush();
  if (quitting) return;
  // Plugin servers are child processes: stop them before the app goes away.
  quitting = true;
  e.preventDefault();
  // The core closes cleanly (running sessions become "interrupted", plugin servers stop).
  const stop = backend instanceof ProcessBackend ? backend.shutdown() : pluginService.dispose().then(() => backend.dispose());
  void Promise.race([stop, new Promise((r) => setTimeout(r, 6000))])
    .catch(() => {})
    .finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
