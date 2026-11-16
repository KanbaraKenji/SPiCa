import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { guardWebviews, setupBrowserSession, type BrowserSessionLike, type GuestLike } from './session';
import { BROWSER_PARTITION } from './policy';

type HostLike = Pick<WebContents, 'on'>;

function fakeSession() {
  const h: Record<string, (...a: never[]) => unknown> = {};
  const flushed: string[] = [];
  const ses: BrowserSessionLike = {
    setPermissionRequestHandler: (f) => void (h.request = f as never),
    setPermissionCheckHandler: (f) => void (h.check = f as never),
    setDevicePermissionHandler: (f) => void (h.device = f as never),
    webRequest: { onBeforeRequest: (f) => void (h.before = f as never) },
    on: (_e, f) => void (h.download = f as never),
    cookies: { on: (_e, f) => void (h.cookies = f as never), flushStore: async () => void flushed.push('cookies') },
    flushStorageData: () => void flushed.push('storage'),
  };
  return { ses, h, flushed };
}

describe('setupBrowserSession', () => {
  it('writes sign-ins to disk a moment after they change, once for a burst of changes', () => {
    vi.useFakeTimers();
    try {
      const { ses, h, flushed } = fakeSession();
      setupBrowserSession(ses);
      for (let i = 0; i < 5; i++) (h.cookies as () => void)();
      expect(flushed).toEqual([]);
      vi.advanceTimersByTime(1000);
      expect(flushed).toEqual(['cookies', 'storage']);
      (h.cookies as () => void)();
      vi.advanceTimersByTime(1000);
      expect(flushed).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses permission requests and checks, and logs the request', () => {
    const { ses, h } = fakeSession();
    const lines: string[] = [];
    setupBrowserSession(ses, { log: (l) => lines.push(l) });
    let granted: boolean | undefined;
    (h.request as (wc: unknown, p: string, cb: (g: boolean) => void) => void)({}, 'media', (g) => (granted = g));
    expect(granted).toBe(false);
    expect((h.check as (wc: unknown, p: string) => boolean)({}, 'geolocation')).toBe(false);
    expect((h.device as () => boolean)()).toBe(false);
    expect(lines).toEqual(['browser: permission refused (media)']);
  });

  it('cancels an outside page reaching a local address, lets the rest through', () => {
    const { ses, h } = fakeSession();
    setupBrowserSession(ses);
    const before = h.before as (
      d: {
        url: string;
        resourceType: string;
        webContents?: { getURL(): string };
      },
      cb: (r: { cancel: boolean }) => void,
    ) => void;
    const ask = (url: string, resourceType: string, top: string) => {
      let cancel: boolean | undefined;
      before({ url, resourceType, webContents: { getURL: () => top } }, (r) => (cancel = r.cancel));
      return cancel;
    };
    expect(ask('http://127.0.0.1:9339/mcp', 'xhr', 'https://evil.example/')).toBe(true);
    expect(ask('https://cdn.example/a.js', 'script', 'https://evil.example/')).toBe(false);
    // the tab's own page going to a local address the person opened
    expect(ask('http://127.0.0.1:5173/', 'mainFrame', 'https://evil.example/')).toBe(false);
  });

  it('does not decide where a download goes (Electron asks where to save)', () => {
    const { ses, h } = fakeSession();
    const lines: string[] = [];
    setupBrowserSession(ses, { log: (l) => lines.push(l) });
    let saved = '';
    const item = {
      getFilename: () => 'a.zip',
      getTotalBytes: () => 10,
      getURL: () => 'https://example.com/a.zip',
      getSavePath: () => saved,
      setSavePath: (p: string) => (saved = p),
    };
    (h.download as (e: unknown, i: typeof item) => void)({}, item);
    expect(saved).toBe('');
    expect(lines[0]).toMatch(/^browser: download asked \(a\.zip, 10 bytes/);
  });
});

function fakeHost() {
  const h: Record<string, (...a: never[]) => unknown> = {};
  const host = {
    on: (e: string, f: never) => void (h[e] = f),
  } as unknown as HostLike;
  return { host, h };
}

function fakeGuest(url = 'https://example.com/') {
  const h: Record<string, (...a: never[]) => unknown> = {};
  const guest = {
    getURL: () => url,
    setWindowOpenHandler: (f: never) => void (h.open = f),
    on: (e: string, f: never) => void (h[e] = f),
  } as unknown as GuestLike;
  return { guest, h };
}

describe('guardWebviews', () => {
  it('locks a webview before it attaches and refuses one with a forbidden address', () => {
    const { host, h } = fakeHost();
    guardWebviews(host, { openTab: () => undefined });
    const attach = h['will-attach-webview'] as (e: { preventDefault(): void }, p: Record<string, unknown>, q: Record<string, unknown>) => void;
    let prevented = 0;
    const prefs: Record<string, unknown> = {
      preload: 'x',
      nodeIntegration: true,
    };
    attach({ preventDefault: () => prevented++ }, prefs, {
      src: 'https://example.com/',
    });
    expect(prevented).toBe(0);
    expect(prefs.preload).toBeUndefined();
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.partition).toBe(BROWSER_PARTITION);
    attach({ preventDefault: () => prevented++ }, {}, { src: 'file:///C:/secret.txt' });
    expect(prevented).toBe(1);
  });

  it('a new window from a page opens as a tab; never a window', () => {
    const { host, h } = fakeHost();
    const tabs: string[] = [];
    guardWebviews(host, { openTab: (u) => tabs.push(u) });
    const g = fakeGuest();
    (h['did-attach-webview'] as (e: unknown, g: GuestLike) => void)({}, g.guest);
    const open = g.h.open as (d: { url: string }) => { action: string };
    expect(open({ url: 'https://other.example/' })).toEqual({ action: 'deny' });
    expect(open({ url: 'file:///C:/x' })).toEqual({ action: 'deny' });
    expect(open({ url: 'about:blank' })).toEqual({ action: 'deny' });
    expect(tabs).toEqual(['https://other.example/']);
  });

  it('stops navigations to forbidden schemes and from an outside page into this machine', () => {
    const { host, h } = fakeHost();
    guardWebviews(host, { openTab: () => undefined });
    const g = fakeGuest('https://evil.example/');
    (h['did-attach-webview'] as (e: unknown, g: GuestLike) => void)({}, g.guest);
    const nav = g.h['will-navigate'] as (e: { preventDefault(): void }, url: string) => void;
    const redirect = g.h['will-redirect'] as (e: { preventDefault(): void }, url: string) => void;
    const stopped = (f: typeof nav, url: string) => {
      let p = false;
      f({ preventDefault: () => (p = true) }, url);
      return p;
    };
    expect(stopped(nav, 'https://ok.example/')).toBe(false);
    expect(stopped(nav, 'file:///C:/x')).toBe(true);
    expect(stopped(nav, 'http://127.0.0.1:9339/')).toBe(true);
    expect(stopped(redirect, 'spica-file://token')).toBe(true);
  });
});

describe('local pages: the lists, and going to the web', () => {
  const hosts = () => ({ scripts: ['cdnjs.cloudflare.com'], fonts: ['fonts.gstatic.com'] });
  it('a local page (its workers and frames too) loads only what the lists allow; each stop is reported', () => {
    const { ses, h } = fakeSession();
    const stopped: string[] = [];
    setupBrowserSession(ses, { localPageHosts: hosts, onLocalBlocked: (_id, page, url) => stopped.push(`${page} ${url}`) });
    const before = h.before as (d: Record<string, unknown>, cb: (r: { cancel: boolean }) => void) => void;
    const ask = (url: string, resourceType: string, top: string, method = 'GET') => {
      let cancel: boolean | undefined;
      before({ url, resourceType, method, webContentsId: 7, webContents: { getURL: () => top } }, (r) => (cancel = r.cancel));
      return cancel;
    };
    const page = 'spica-page://tok/report.html';
    expect(ask('https://cdnjs.cloudflare.com/lib.js', 'script', page)).toBe(false);
    expect(ask('spica-page://tok/app.js', 'script', page)).toBe(false);
    expect(ask('https://evil.example/x.js', 'script', page)).toBe(true);
    expect(ask('https://img.example/a.png', 'image', page)).toBe(true);
    expect(ask('https://api.example/send', 'xhr', page)).toBe(true);
    // the same requests from a web page the person opened: not this rule
    expect(ask('https://img.example/a.png', 'image', 'https://news.example/')).toBe(false);
    expect(stopped).toEqual([`${page} https://evil.example/x.js`, `${page} https://img.example/a.png`, `${page} https://api.example/send`]);
  });

  it("a local page's own navigation or new window to the web is not done in the page; it is asked about", () => {
    const { host, h } = fakeHost();
    const asked: string[] = [];
    const tabs: string[] = [];
    guardWebviews(host, { openTab: (u) => tabs.push(u), localLink: (u) => asked.push(u) });
    const g = fakeGuest('spica-page://tok/report.html');
    (h['did-attach-webview'] as (e: unknown, g: GuestLike) => void)({}, g.guest);
    let prevented = false;
    (g.h['will-navigate'] as (e: { preventDefault(): void }, url: string) => void)({ preventDefault: () => (prevented = true) }, 'https://evil.example/?d=secret');
    (g.h.open as (d: { url: string }) => unknown)({ url: 'https://docs.example/' });
    expect(prevented).toBe(true);
    expect(asked).toEqual(['https://evil.example/?d=secret', 'https://docs.example/']);
    expect(tabs).toEqual([]);
  });
});