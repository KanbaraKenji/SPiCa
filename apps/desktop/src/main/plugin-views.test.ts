import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { BRIDGE_JS, contentType, injectIntoPage, pageCsp, parsePluginUrl, pluginThemeVars, themeCss } from './plugin-views';
import { pluginCallId, pluginCallProblem } from '../shared/plugin-view';

describe('plugin pages', () => {
  it('reads plugin and path from the URL; never leaves the plugin', () => {
    expect(parsePluginUrl('spica-plugin://notes/ui/index.html')).toEqual({ plugin: 'notes', path: 'ui/index.html' });
    expect(parsePluginUrl('spica-plugin://notes/ui/%E7%AC%94%E8%AE%B0.css')).toEqual({ plugin: 'notes', path: 'ui/笔记.css' });
    // URL rules fold ../ away: it can only land inside the plugin (the plugin manager checks again).
    expect(parsePluginUrl('spica-plugin://notes/ui/%2E%2E/%2E%2E/secret')).toEqual({ plugin: 'notes', path: 'secret' });
    expect(parsePluginUrl('https://notes/ui/index.html')).toBeNull();
  });

  it('puts the theme and the bridge first in the page', () => {
    const out = injectIntoPage('<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body><script src="app.js"></script></body></html>', 'notes');
    const theme = out.indexOf('spica-plugin://notes/__spica/theme.css');
    const bridge = out.indexOf('spica-plugin://notes/__spica/bridge.js');
    expect(theme).toBeGreaterThan(out.indexOf('<head>'));
    expect(bridge).toBeGreaterThan(theme);
    expect(bridge).toBeLessThan(out.indexOf('app.js'));
    expect(injectIntoPage('<p>no head</p>', 'notes').startsWith('<link')).toBe(true);
  });

  it('lets a page load only its own plugin, and nothing from the network', () => {
    const csp = pageCsp('notes');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('script-src spica-plugin://notes;');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toMatch(/https?:\/\/(?!localhost|127)/);
  });

  it('gives pages the agreed theme variables', () => {
    const vars = pluginThemeVars({ '--spica-bg': '#262624', '--spica-ink': '#ecebe5' }, 'Segoe UI');
    expect(Object.keys(vars).sort()).toEqual(['--spica-accent', '--spica-bg', '--spica-border', '--spica-danger', '--spica-fg', '--spica-font', '--spica-muted', '--spica-radius', '--spica-surface'].sort());
    expect(vars['--spica-fg']).toBe('#ecebe5');
    expect(themeCss(vars, 'dark')).toContain('color-scheme: dark');
    expect(contentType('ui/app.js')).toMatch(/javascript/);
  });

  it('says plugin call failures in words', () => {
    expect(pluginCallProblem('[TOOL_NOT_ALLOWED] delete_all')).toBe('该页面无权使用此工具。');
    expect(pluginCallProblem('note not found')).toBeNull();
  });
});

describe('a preview page’s script failing before it is drawn (window.spica in the page)', () => {
  /** Runs the bridge in a stand-in page; returns what it posts to the window and the page's own error listener. */
  function page() {
    const posted: { call?: string; args?: { text?: string } }[] = [];
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const win: Record<string, unknown> = {
      parent: { postMessage: (m: object) => posted.push(m) },
      addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] ??= []).push(fn),
    };
    runInNewContext(BRIDGE_JS, { window: win, document: { documentElement: { dataset: {}, style: {} } }, console });
    const fire = (message: string) => listeners.error?.forEach((fn) => fn({ message }));
    return { posted, fire, spica: win.spica as { preview: { ready(): Promise<unknown> } } };
  }

  it('an error before ready() is said; the browser’s ResizeObserver loop notice is not an error', () => {
    const p = page();
    p.fire('ResizeObserver loop completed with undelivered notifications.');
    expect(p.posted.filter((m) => m.call === 'previewError')).toEqual([]);
    p.fire('x is not defined');
    expect(p.posted.filter((m) => m.call === 'previewError').map((m) => m.args?.text)).toEqual(['x is not defined']);
  });

  it('after ready() errors are the page’s own business', () => {
    const p = page();
    void p.spica.preview.ready();
    p.fire('x is not defined');
    expect(p.posted.filter((m) => m.call === 'previewError')).toEqual([]);
  });
});

describe('the id of a page call (it names the call so it can be stopped)', () => {
  it('a short plain string passes; anything else is nothing', () => {
    expect(pluginCallId('3f2a9c1e-8b7d-4e21-9a55-0c1d2e3f4a5b')).toBe('3f2a9c1e-8b7d-4e21-9a55-0c1d2e3f4a5b');
    expect(pluginCallId('call_1')).toBe('call_1');
    for (const bad of [undefined, null, 7, {}, '', 'a b', 'a/b', '../x', 'x'.repeat(65)]) expect(pluginCallId(bad)).toBeUndefined();
  });
});
