// What the built-in browser lets a web page do. Pure rules, no Electron here: browser/session.ts wires them
// to the browser's own session and to every <webview> the app window attaches.
//
// A page in the browser is untrusted content. It runs in its own process and storage partition, with no preload
// and no app interface; it may load only web addresses (and the one local file it was opened for, through the
// browser's own scheme); it gets no device or notification permissions; and a page from the internet cannot
// reach services listening on this machine or the local network.

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

/** An IPv4 address as four numbers, or null. */
function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/**
 * This machine or the local network: localhost names, loopback, private, link-local and carrier-grade NAT
 * addresses, IPv6 loopback, unique-local and link-local. `host` as URL.hostname gives it (IPv6 in brackets).
 */
export function isLocalHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = ipv4(h);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!h.includes(':')) return false;
  if (h === '::1' || h === '::') return true;
  // IPv4-mapped (::ffff:127.0.0.1, or as URL writes it, ::ffff:7f00:1)
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) {
    const rest = mapped[1]!;
    if (ipv4(rest)) return isLocalHost(rest);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return isLocalHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
  }
  return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
}

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
  // The browser's own local files and empty pages count as local: a local HTML file may talk to a local server.
  if (from === null) return !(top === 'about:blank' || top.startsWith(`${BROWSER_FILE_SCHEME}:`));
  return !isLocalHost(from);
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
