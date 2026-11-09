// Main process of the Spica desktop shell.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, safeStorage, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import { IpcChannel, type AgentApi, type AppInfo } from '@spica/protocol';
import { DesktopChannel } from '../shared/ipc';
import { deriveTokens, resolveSkin, schemeOf } from '../shared/skin';
import { clampZoom, DEFAULT_ZOOM, stepZoom } from '../shared/zoom';
import { mailForCore, networkForCore, type ShellSettings } from '../shared/settings';
import type { LocalConnectInfo, NetworkState } from '../shared/bridge';
import type { ProviderList, ShellState, UsageLogRequest, UsageLogResult, WorkflowsState } from '../shared/bridge';
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
import { flatten, icoFromPngs, inkFor } from './icon';
import { PREVIEW_SCHEME, PreviewFiles, readPreview } from './preview';
import { BRIDGE_JS, contentType, injectIntoPage, pageCsp, parsePluginUrl, PLUGIN_SCHEME, pluginThemeVars, themeCss } from './plugin-views';
import { FONT_UI, type PluginView, type PluginViewResult } from '../shared/plugin-view';
import { readFile } from 'node:fs/promises';

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
//   SPICA_SAVE_TO=<dir>      save files (usage log) there without asking (not in installed builds)
const forcedTheme = process.env.SPICA_THEME;
const capturePath = process.env.SPICA_CAPTURE;
const shotsDir = process.env.SPICA_SHOTS;
const automated = Boolean(capturePath || shotsDir);

app.setName(APP_NAME);
// The development build has its own id: with the same one as an installed Spica,
// Windows groups its window under that shortcut and shows the shortcut's icon.
const APP_USER_MODEL_ID = app.isPackaged ? 'dev.spica.desktop' : 'dev.spica.desktop.dev';
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
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

// 允许本机脚本连接 Spica: the core serves MCP over HTTP on 127.0.0.1; scripts (e.g. the plugin
// skill's install script) read where from mcp-http.json and the token from mcp-token.
const mcpInfoFile = join(app.getPath('userData'), 'mcp-http.json');
const mcpTokenFile = join(app.getPath('userData'), 'mcp-token');
// Left by a run that did not end cleanly: no service behind it now.
rmSync(mcpInfoFile, { force: true });
let localConnectApplied: Promise<unknown> = Promise.resolve();
function applyLocalConnect(on: boolean): Promise<unknown> {
  if (!(backend instanceof ProcessBackend)) return Promise.resolve();
  const b = backend;
  localConnectApplied = localConnectApplied.then(() => b.localConnect(on)).catch((err: unknown) => console.warn('[spica] local connect:', err instanceof Error ? err.message : err));
  return localConnectApplied;
}

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
      mail: mailForCore(settings.get().mail),
      network: networkForCore(settings.get().network),
      // Development limits (see docs/design/agent-core.md §10): Anthropic 100 USD total, 2 USD per call.
      budget: { perProvider: { anthropic: { globalUsd: 100, perCallUsd: 2 } }, perRunUsd: 1 },
      // Linked into the backend entry; named here as the core expects.
      extractorModules: ['@spica/extract'],
      extensions: [
        {
          module: '@spica/desktop-host',
          options: { pluginRoot, pluginSourcesFile: join(app.getPath('userData'), 'plugin-sources.json'), mcpInfoFile, mcpTokenFile },
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
          // Each (re)start of the core: bring back what the settings ask for.
          if (s.state === 'ready' && settings.get().localConnect) void applyLocalConnect(true);
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
  'renameProject',
  'deleteProject',
  'setSessionModel',
  'setApprovalMode',
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

/**
 * Window / taskbar icon: the flower in one flat color, white on a dark Windows
 * taskbar and black on a light one, no tile (main/icon.ts).
 */
function windowIcon(): Electron.NativeImage | undefined {
  const dark = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  const file = join(app.getAppPath(), 'resources', 'branding', 'png', `spica-win-${dark ? 'dark' : 'light'}.png`);
  if (!existsSync(file)) return undefined;
  const base = nativeImage.createFromPath(file);
  if (base.isEmpty()) return undefined;
  return nativeImage.createFromBitmap(Buffer.from(flatten(base.toBitmap(), inkFor(dark))), base.getSize());
}

/**
 * Puts the icon on the window and on its taskbar button. The taskbar would
 * otherwise show the shortcut's icon (the installer's tile), so the window
 * gets its own .ico, written next to the settings.
 */
function applyWindowIcon(win: BrowserWindow): void {
  const icon = windowIcon();
  if (!icon) return;
  win.setIcon(icon);
  if (process.platform !== 'win32') return;
  try {
    const ink = inkFor(nativeTheme.shouldUseDarkColorsForSystemIntegratedUI);
    const dir = join(app.getPath('userData'), 'icons');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `taskbar-${ink}.ico`);
    const images = [256, 48, 32, 16].map((size) => ({ size, png: icon.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
    writeFileSync(file, icoFromPngs(images));
    win.setAppDetails({ appId: APP_USER_MODEL_ID, appIconPath: file, appIconIndex: 0 });
  } catch {
    // The window icon above is still set; only the taskbar button keeps the shortcut's icon.
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
      // The built-in PDF viewer, for previews in the right panel.
      plugins: true,
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
  applyWindowIcon(win);
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

// Previews: files the user opened from a conversation, shown in the right panel.
// The PDF viewer and images load them through spica-file://<token> (only those files).
// Plugin pages load their own files through spica-plugin://<plugin>/<path> (see plugin-views.ts).
protocol.registerSchemesAsPrivileged([
  { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
const previewFiles = new PreviewFiles();

ipcMain.handle(DesktopChannel.Preview, async (_e, sessionId: unknown, path: unknown) => {
  const raw = typeof path === 'string' ? path : '';
  const session = typeof sessionId === 'string' && sessionId ? await backend.getSession(sessionId).catch(() => undefined) : undefined;
  const full = isAbsolute(raw) ? raw : resolvePath(session?.cwd || app.getPath('home'), raw);
  return readPreview(full, previewFiles);
});

ipcMain.handle(DesktopChannel.LocalConnect, async (): Promise<LocalConnectInfo | null> => {
  if (!(backend instanceof ProcessBackend)) return null;
  await localConnectApplied;
  return backend.localConnectState().catch(() => null);
});

ipcMain.handle(DesktopChannel.Network, async (): Promise<NetworkState | null> => {
  if (!(backend instanceof ProcessBackend)) return null;
  try {
    return { ...(await backend.networkSettings()), problems: networkProblems };
  } catch {
    return null;
  }
});

// Plugin pages: only through the plugin manager, which knows the plugin's folder and its pages' tools.
const str = (v: unknown) => (typeof v === 'string' ? v : '');
ipcMain.handle(DesktopChannel.PluginViews, async (): Promise<PluginView[]> => {
  if (!(backend instanceof ProcessBackend)) return [];
  return backend.pluginViews().catch(() => []);
});
ipcMain.handle(DesktopChannel.PluginViewCall, async (_e, plugin: unknown, view: unknown, tool: unknown, args: unknown, confirmed: unknown): Promise<PluginViewResult> => {
  if (!(backend instanceof ProcessBackend)) return { content: '[UNSUPPORTED] 这个版本不能运行插件页面。', isError: true };
  try {
    return await backend.pluginViewCall({ plugin: str(plugin), view: str(view), tool: str(tool), args: args ?? {}, confirmed: confirmed === true });
  } catch (err) {
    // The plugin's own words beat a generic "no answer": the page shows them to whoever is fixing the plugin.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[spica] plugin page call failed:', msg);
    return { content: /[一-鿿]/.test(msg) ? msg : `插件没有完成这次调用：${msg.slice(0, 300)}`, isError: true };
  }
});
ipcMain.handle(DesktopChannel.PluginViewFile, async (_e, plugin: unknown, path: unknown): Promise<string | null> => {
  if (!(backend instanceof ProcessBackend)) return null;
  return backend.pluginViewFile({ plugin: str(plugin), path: str(path) }).catch(() => null);
});

function pluginTheme(): { css: string } {
  const s = settings.get();
  const skin = resolveSkin(s.skin, nativeTheme.shouldUseDarkColors, s.customSkins);
  const mode = schemeOf(skin.bg);
  return { css: themeCss(pluginThemeVars(deriveTokens(skin), FONT_UI), mode) };
}

async function servePluginFile(url: string): Promise<Response> {
  const notFound = () => new Response('', { status: 404 });
  const req = parsePluginUrl(url);
  if (!req) return notFound();
  if (req.path === '__spica/bridge.js') return new Response(BRIDGE_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
  if (req.path === '__spica/theme.css') return new Response(pluginTheme().css, { headers: { 'content-type': 'text/css; charset=utf-8' } });
  if (!(backend instanceof ProcessBackend)) return notFound();
  const file = await backend.pluginViewFile({ plugin: req.plugin, path: req.path }).catch(() => null);
  if (!file) return notFound();
  const type = contentType(file);
  if (type.startsWith('text/html')) {
    const html = await readFile(file, 'utf8').catch(() => null);
    if (html === null) return notFound();
    return new Response(injectIntoPage(html, req.plugin), { headers: { 'content-type': type, 'content-security-policy': pageCsp(req.plugin) } });
  }
  const res = await net.fetch(pathToFileURL(file).toString());
  return new Response(res.body, { status: res.status, headers: { 'content-type': type } });
}

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
let lastNetwork = JSON.stringify(settings.get().network);
let lastLocalConnect = settings.get().localConnect;
/** Problems the core reported for the network settings (e.g. a certificate file it cannot read), in words. */
let networkProblems: string[] = [];
function networkProblem(raw: string): string {
  if (/ca|certificate|pem/i.test(raw)) return `读不了证书文件：${settings.get().network.caFile || raw}`;
  if (/proxy/i.test(raw)) return `代理地址不对：${settings.get().network.proxy || raw}`;
  return `网络设置有问题：${raw}`;
}
settings.onChange((s) => {
  if (!(backend instanceof ProcessBackend)) return;
  const mail = JSON.stringify(s.mail);
  if (mail !== lastMail) {
    lastMail = mail;
    void backend.apply({ mail: mailForCore(s.mail) }).catch(() => undefined);
  }
  if (s.localConnect !== lastLocalConnect) {
    lastLocalConnect = s.localConnect;
    void applyLocalConnect(s.localConnect);
  }
  const net = JSON.stringify(s.network);
  if (net !== lastNetwork) {
    lastNetwork = net;
    void backend
      .apply({ network: networkForCore(s.network) })
      .then((r) => {
        networkProblems = r.warnings.map(networkProblem);
      })
      .catch(() => undefined);
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

ipcMain.handle(DesktopChannel.UsageLog, async (_e, raw: unknown): Promise<UsageLogResult> => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 200) : undefined);
  const req: UsageLogRequest = {};
  const projectId = str(r.projectId);
  const from = str(r.from);
  const to = str(r.to);
  if (projectId) req.projectId = projectId;
  if (from) req.from = from;
  if (to) req.to = to;
  const day = new Date().toLocaleDateString('sv-SE').replaceAll('-', '');
  mkdirSync(workDir, { recursive: true });
  const opts: Electron.SaveDialogOptions = { title: '导出使用日志', defaultPath: join(workDir, `使用日志-${day}.jsonl`), filters: [{ name: '使用日志', extensions: ['jsonl'] }] };
  // SPICA_SAVE_TO=<folder> (development only): skip the dialog, so scripts never leave one open.
  const saveTo = app.isPackaged ? '' : (process.env.SPICA_SAVE_TO ?? '');
  const pick = saveTo
    ? { canceled: false, filePath: join(saveTo, basename(opts.defaultPath ?? 'usage-log.jsonl')) }
    : mainWindow
      ? await dialog.showSaveDialog(mainWindow, opts)
      : await dialog.showSaveDialog(opts);
  if (pick.canceled || !pick.filePath) return null;
  try {
    if (backend instanceof ProcessBackend) return await backend.usageLog({ filter: req, file: pick.filePath });
    // Demo data: a header and two fictional records, so the page can be tried without the core.
    const header = { type: 'header', schema: 'spica.usage-log', version: 1, demo: true, filter: req };
    const rows = [{ type: 'session', id: 's-chat-1', title: '看一下样机评审资料' }, { type: 'message', sessionId: 's-chat-1', role: 'user', text: '帮我看看样机评审的资料' }];
    writeFileSync(pick.filePath, [header, ...rows].map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    return { file: pick.filePath, records: rows.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/EACCES|EPERM|EBUSY|EROFS|ENOENT/.test(msg)) return { error: '写不进这个位置（可能被占用或没有权限），换一个文件夹试试。' };
    return { error: friendly(err) };
  }
});

ipcMain.on(DesktopChannel.ShowInFolder, (_e, path: unknown) => {
  if (typeof path === 'string' && existsSync(path)) shell.showItemInFolder(path);
});

ipcMain.handle(DesktopChannel.PickFiles, async (_e, title: unknown): Promise<string[]> => {
  const opts: Electron.OpenDialogOptions = { title: typeof title === 'string' && title ? title.slice(0, 60) : '选择文件', properties: ['openFile', 'multiSelections'] };
  const r = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? [] : r.filePaths.slice(0, 20);
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
  applyWindowIcon(mainWindow);
  syncNativeChrome(mainWindow, settings.get());
  mainWindow.webContents.send(DesktopChannel.SettingsChanged, settings.get());
});

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle(PLUGIN_SCHEME, (req) => servePluginFile(req.url));
  protocol.handle(PREVIEW_SCHEME, (req) => {
    const file = previewFiles.pathOf(req.url);
    return file ? net.fetch(pathToFileURL(file).toString()) : new Response('', { status: 404 });
  });
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
