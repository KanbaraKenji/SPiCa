// What the built-in browser lets a web page do. Pure rules, no Electron here: browser/session.ts wires them
// to the browser's own session and to every <webview> the app window attaches.
//
// A page in the browser is untrusted content. It runs in its own process and storage partition, with no preload
// and no app interface; it may load only web addresses (and the one local file it was opened for, through the
// browser's own scheme); it gets no device or notification permissions; and a page from the internet cannot
// reach services listening on this machine or the local network.
import { isLocalHost } from '../../shared/local-host';

/** The browser's storage partition: its own cookies, cache and storage, apart from the app window's. */
export const BROWSER_PARTITION = 'persist:spica-browser';

/** The scheme the browser serves a local file through (only files opened in a tab, by token). */
export const BROWSER_FILE_SCHEME = 'spica-page';

/** Where a tab may go: the web, an empty page, and local files the browser serves itself. */
export function navigable(url: string): boolean {
  if (url === 'about:blank') return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === `${BROWSER_FILE_SCHEME}:`;
}

// Part of these rules; kept in shared/ because 设置 › MCP 服务 uses it too.
export { isLocalHost };

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ws:' || u.protocol === 'wss:' ? u.hostname : null;
  } catch {
    return null;
  }
}

/**
 * Whether a request is stopped because a page from outside reaches into this machine or the local network.
 * `top` is the address of the tab's page (undefined: the request is the page itself). A page the person opened
 * on a local address may use local addresses; a page from the internet may not.
 */
export function blocksLocalRequest(request: string, top: string | undefined): boolean {
  const target = hostOf(request);
  if (!target || !isLocalHost(target)) return false;
  // No page yet (the tab's first load): nothing outside is asking.
  if (!top) return false;
  const from = hostOf(top);
  // An empty page counts as local. A local HTML file does not: it can read its folder, and must not hand what it
  // read to a service on this machine or the local network.
  if (from === null) return top !== 'about:blank';
  return !isLocalHost(from);
}

/**
 * What a local page (an HTML file, or a page drawn from an answer: spica-page) may load from the network, as Claude's
 * artifacts do (code.claude.com/docs/en/artifacts, checked 2026-11-16): scripts from five public CDNs (jsDelivr's
 * /npm/ path only), fonts and their style sheets from Google Fonts; nothing else — no other style sheets or pictures,
 * no fetch / XHR / WebSocket beyond Google Fonts, no form sent, no frame from the web. Each entry is a host, or a
 * host and the start of the path. deploy.json's "localPageHosts" replaces either list (a company's own script store).
 */
export interface LocalPageHosts {
  scripts: string[];
  fonts: string[];
}

export const LOCAL_PAGE_HOSTS: LocalPageHosts = {
  scripts: ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net/npm/', 'cdn.tailwindcss.com', 'code.jquery.com', 'unpkg.com'],
  fonts: ['fonts.googleapis.com', 'fonts.gstatic.com'],
};

/** deploy.json's "localPageHosts": { "scripts": [...], "fonts": [...] }, each list replacing the default when given. */
export function localPageHostsFrom(deploy: unknown): LocalPageHosts {
  const raw = deploy && typeof deploy === 'object' ? (deploy as Record<string, unknown>).localPageHosts : undefined;
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const list = (v: unknown, fallback: string[]) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim().toLowerCase()) : fallback);
  return { scripts: list(o.scripts, LOCAL_PAGE_HOSTS.scripts), fonts: list(o.fonts, LOCAL_PAGE_HOSTS.fonts) };
}

/** Whether an address is on a list (host, or host and the start of the path). https only. */
function listed(url: URL, entries: string[]): boolean {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return entries.some((e) => {
    const at = e.indexOf('/');
    if (at < 0) return host === e;
    return host === e.slice(0, at) && url.pathname.startsWith(e.slice(at));
  });
}

/** Whether the page is a local page (its address in the browser's own scheme). */
export function isLocalPage(url: string | undefined): boolean {
  return !!url && url.startsWith(`${BROWSER_FILE_SCHEME}:`);
}

/** Whether a local page may make this request (its own folder, data and blob always; the web as the lists say). */
export function localPageAllows(request: { url: string; resourceType: string; method?: string }, hosts: LocalPageHosts): boolean {
  let u: URL;
  try {
    u = new URL(request.url);
  } catch {
    return false;
  }
  if (u.protocol === `${BROWSER_FILE_SCHEME}:` || u.protocol === 'data:' || u.protocol === 'blob:') return true;
  const method = (request.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  switch (request.resourceType) {
    case 'script':
      return listed(u, hosts.scripts);
    case 'stylesheet':
    case 'font':
    case 'xhr':
      return listed(u, hosts.fonts);
    default:
      return false;
  }
}

/** The settings every <webview> in the app window gets, whatever the page asked for. */
export interface LockedPreferences {
  partition: string;
  sandbox: true;
  contextIsolation: true;
  nodeIntegration: false;
  nodeIntegrationInSubFrames: false;
  webSecurity: true;
  allowRunningInsecureContent: false;
  /** Chromium's PDF viewer (the only plugin Electron has): PDFs on the web show in the tab. */
  plugins: true;
  experimentalFeatures: false;
  javascript: true;
  webviewTag: false;
  navigateOnDragDrop: false;
  spellcheck: false;
}

export const LOCKED: LockedPreferences = {
  partition: BROWSER_PARTITION,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  plugins: true,
  experimentalFeatures: false,
  javascript: true,
  webviewTag: false,
  navigateOnDragDrop: false,
  spellcheck: false,
};

/**
 * Rewrites a <webview>'s settings before it attaches (will-attach-webview): no preload, the locked settings
 * above. Returns false when it may not attach at all (its first address is not one a tab may load).
 */
export function lockWebview(prefs: Record<string, unknown>, params: Record<string, unknown>): boolean {
  for (const key of ['preload', 'preloadURL', 'additionalArguments', 'session']) delete prefs[key];
  Object.assign(prefs, LOCKED);
  const src = typeof params.src === 'string' ? params.src : '';
  params.partition = BROWSER_PARTITION;
  for (const key of [
    'preload',
    'nodeintegration',
    'nodeintegrationinsubframes',
    'plugins',
    'disablewebsecurity',
    'webpreferences',
    'blinkfeatures',
    'enableblinkfeatures',
  ])
    delete params[key];
  return src === '' || navigable(src);
}

/** Permissions a page may have: none (camera, microphone, location, notifications, clipboard, devices… all refused). */
const PERMITTED: ReadonlySet<string> = new Set();

export function permits(permission: string): boolean {
  return PERMITTED.has(permission);
}
