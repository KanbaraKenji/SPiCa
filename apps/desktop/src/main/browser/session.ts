// The built-in browser's session and its <webview>s: browser/policy.ts's rules applied where Electron asks.
// Typed against the few members used, so tests can pass plain objects.
import type { WebContents } from 'electron';
import { blocksLocalRequest, lockWebview, navigable, permits } from './policy';

interface RequestDetails {
  url: string;
  resourceType: string;
  method?: string;
  webContentsId?: number | undefined;
  webContents?: { getURL(): string } | undefined;
}

/** The parts of Electron's Session the browser sets up. */
export interface BrowserSessionLike {
  setPermissionRequestHandler(h: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void): void;
  setPermissionCheckHandler(h: (wc: unknown, permission: string) => boolean): void;
  setDevicePermissionHandler(h: () => boolean): void;
  webRequest: {
    onBeforeRequest(listener: (details: RequestDetails, callback: (r: { cancel: boolean }) => void) => void): void;
  };
  on(event: 'will-download', listener: (e: unknown, item: DownloadItemLike) => void): unknown;
  cookies: { on(event: 'changed', listener: () => void): unknown; flushStore(): Promise<void> };
  flushStorageData(): void;
}

export interface DownloadItemLike {
  getFilename(): string;
  getTotalBytes(): number;
  getURL(): string;
  getSavePath(): string;
}

export interface BrowserSessionOptions {
  /** One line for the app's log (requests stopped, downloads). */
  log?: (line: string) => void;
  /** How long after a sign-in changes it is written to disk (default 1 s). */
  flushAfterMs?: number;
  /** Whether a page's form sending is stopped now (an agent's unconfirmed click or key a moment ago; agent.ts). */
  stopSubmit?: (wcId: number) => boolean;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.length > 40 ? `${u.pathname.slice(0, 40)}…` : u.pathname}`;
  } catch {
    return url.slice(0, 60);
  }
}

/**
 * Sets up the browser's session once: every permission refused, requests from an outside page into this machine
 * or the local network stopped, downloads left to Electron's own save prompt (no save path is set here, so each
 * one asks where to save; nothing is saved or opened on its own).
 */
export function setupBrowserSession(ses: BrowserSessionLike, o: BrowserSessionOptions = {}): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    o.log?.(`browser: permission refused (${permission})`);
    callback(permits(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => permits(permission));
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const top = details.resourceType === 'mainFrame' ? undefined : details.webContents?.getURL();
    if (blocksLocalRequest(details.url, top)) {
      o.log?.(`browser: request to a local address stopped (${shortUrl(details.url)} from ${shortUrl(top ?? '')})`);
      callback({ cancel: true });
      return;
    }
    // A page sending a form (not GET) right after an agent's click or key nobody confirmed: stopped. Only form
    // navigations: a page's own fetch / XHR cannot be told apart from its ordinary work and is not stopped here.
    const method = (details.method ?? 'GET').toUpperCase();
    const frame = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
    if (frame && method !== 'GET' && method !== 'HEAD' && details.webContentsId !== undefined && o.stopSubmit?.(details.webContentsId)) {
      o.log?.(`browser: a form sent after an unconfirmed agent action was stopped (${method} ${shortUrl(details.url)})`);
      callback({ cancel: true });
      return;
    }
    callback({ cancel: false });
  });
  ses.on('will-download', (_e, item) => {
    o.log?.(`browser: download asked (${item.getFilename()}, ${item.getTotalBytes()} bytes, ${shortUrl(item.getURL())})`);
  });
  // Sign-ins are kept until cleared (设置 › 常规 › 浏览器): written to disk soon after they change, so a crash or a
  // forced end of the app does not lose them (Chromium on its own writes them only now and then).
  let flush: ReturnType<typeof setTimeout> | undefined;
  ses.cookies.on('changed', () => {
    if (flush) return;
    flush = setTimeout(() => {
      flush = undefined;
      flushBrowserSession(ses);
    }, o.flushAfterMs ?? 1000);
  });
}

/** Writes the browser's sign-ins and page storage to disk now (also when the app quits). */
export function flushBrowserSession(ses: Pick<BrowserSessionLike, 'cookies' | 'flushStorageData'>): void {
  void ses.cookies.flushStore().catch(() => undefined);
  ses.flushStorageData();
}

/** A guest page (a <webview>'s WebContents): the parts the browser wires. */
export type GuestLike = Pick<WebContents, 'getURL' | 'setWindowOpenHandler' | 'on'>;
export interface WebviewOptions {
  /** A page asked for a new window (a link with target=_blank, window.open): it opens as a new tab instead. */
  openTab(url: string, opener: GuestLike): void;
  log?: (line: string) => void;
}

/** Locks every <webview> the app window attaches and wires its page's new windows and navigations. */
export function guardWebviews(host: Pick<WebContents, 'on'>, o: WebviewOptions): void {
  host.on('will-attach-webview', (e, prefs, params) => {
    if (!lockWebview(prefs as unknown as Record<string, unknown>, params as unknown as Record<string, unknown>)) {
      o.log?.(`browser: webview refused (${shortUrl(String(params.src ?? ''))})`);
      e.preventDefault();
    }
  });
  host.on('did-attach-webview', (_e, guest) => wireGuest(guest, o));
}

export function wireGuest(guest: GuestLike, o: WebviewOptions): void {
  guest.setWindowOpenHandler(({ url }) => {
    if (navigable(url) && url !== 'about:blank') o.openTab(url, guest);
    return { action: 'deny' };
  });
  // Navigations the page starts (links, scripts, forms); an address the person types is loaded, not navigated here.
  const check = (e: { preventDefault(): void }, url: string) => {
    if (!navigable(url) || blocksLocalRequest(url, guest.getURL() || undefined)) {
      o.log?.(`browser: navigation stopped (${shortUrl(url)})`);
      e.preventDefault();
    }
  };
  guest.on('will-navigate', check);
  guest.on('will-redirect', check);
}
