import { describe, expect, it } from 'vitest';
import { BROWSER_PARTITION, blocksLocalRequest, isLocalHost, LOCKED, lockWebview, navigable, permits } from './policy';

describe('navigable: where a tab may go', () => {
  it.each([
    ['https://example.com/a', true],
    ['http://127.0.0.1:5173/', true],
    ['about:blank', true],
    ['spica-page://abc/index.html', true],
    ['file:///C:/x.html', false],
    ['spica-file://token', false],
    ['spica-plugin://notes/ui/index.html', false],
    ['chrome://settings', false],
    ['devtools://devtools/bundled/inspector.html', false],
    ['javascript:alert(1)', false],
    ['data:text/html,<b>x</b>', false],
    ['not a url', false],
  ])('%s → %s', (url, ok) => expect(navigable(url)).toBe(ok));
});

describe('isLocalHost: this machine or the local network', () => {
  it.each([
    ['localhost', true],
    ['app.localhost', true],
    ['127.0.0.1', true],
    ['127.8.9.10', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.20', true],
    ['169.254.1.1', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['[::1]', true],
    ['[::ffff:7f00:1]', true],
    ['[::ffff:127.0.0.1]', true],
    ['[fd12:3456::1]', true],
    ['[fe80::1]', true],
    ['[2001:db8::1]', false],
    ['example.com', false],
    ['8.8.8.8', false],
    ['localhost.example.com', false],
  ])('%s → %s', (host, local) => expect(isLocalHost(host)).toBe(local));

  it('reads hosts the way URL writes them', () => {
    expect(isLocalHost(new URL('http://[::ffff:127.0.0.1]:80/').hostname)).toBe(true);
    expect(isLocalHost(new URL('http://LOCALHOST./').hostname)).toBe(true);
  });
});

describe('blocksLocalRequest: an outside page cannot reach this machine', () => {
  it('stops a page from the internet calling a local server', () => {
    expect(blocksLocalRequest('http://127.0.0.1:9339/mcp', 'https://evil.example/')).toBe(true);
    expect(blocksLocalRequest('ws://localhost:8080/', 'https://evil.example/')).toBe(true);
    expect(blocksLocalRequest('http://192.168.1.1/admin', 'https://evil.example/')).toBe(true);
  });
  it('lets the person open a local address, and a local page use local addresses', () => {
    expect(blocksLocalRequest('http://127.0.0.1:5173/', undefined)).toBe(false);
    expect(blocksLocalRequest('http://127.0.0.1:5173/app.js', 'http://localhost:5173/')).toBe(false);
  });
  it('a local HTML file (it can read its folder) cannot reach this machine or the local network either', () => {
    expect(blocksLocalRequest('http://127.0.0.1:5173/api', 'spica-page://tok/index.html')).toBe(true);
    expect(blocksLocalRequest('http://192.168.1.5/', 'spica-page://tok/index.html')).toBe(true);
  });
  it('a first load with no page yet is not stopped', () => {
    expect(blocksLocalRequest('http://127.0.0.1:5173/', '')).toBe(false);
  });
  it('requests to the internet are never stopped by this rule', () => {
    expect(blocksLocalRequest('https://cdn.example/lib.js', 'https://evil.example/')).toBe(false);
    expect(blocksLocalRequest('https://cdn.example/lib.js', 'spica-page://tok/a.html')).toBe(false);
  });
});

describe('lockWebview: whatever a <webview> asks for, it gets the locked settings', () => {
  it('drops the preload and every loosened setting, fixes the partition', () => {
    const prefs: Record<string, unknown> = {
      preload: 'C:/evil.js',
      preloadURL: 'file:///evil.js',
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      partition: 'persist:main',
      session: {},
    };
    const params: Record<string, unknown> = {
      src: 'https://example.com/',
      partition: 'persist:main',
      nodeintegration: 'on',
      preload: 'file:///evil.js',
      webpreferences: 'nodeIntegration=yes',
    };
    expect(lockWebview(prefs, params)).toBe(true);
    expect(prefs).toEqual(LOCKED);
    expect(prefs.preload).toBeUndefined();
    expect(params).toEqual({
      src: 'https://example.com/',
      partition: BROWSER_PARTITION,
    });
  });
  it('refuses one whose first address a tab may not load', () => {
    expect(lockWebview({}, { src: 'file:///C:/Windows/win.ini' })).toBe(false);
    expect(lockWebview({}, { src: 'spica-file://token' })).toBe(false);
    expect(lockWebview({}, {})).toBe(true);
  });
});

it('permits: every permission is refused', () => {
  for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'hid', 'serial', 'usb', 'fullscreen', 'openExternal']) expect(permits(p)).toBe(false);
});
