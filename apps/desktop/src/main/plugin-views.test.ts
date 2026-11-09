import { describe, expect, it } from 'vitest';
import { contentType, injectIntoPage, pageCsp, parsePluginUrl, pluginThemeVars, themeCss } from './plugin-views';
import { pluginCallProblem } from '../shared/plugin-view';

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
    expect(pluginCallProblem('[TOOL_NOT_ALLOWED] delete_all')).toBe('这个页面不能用这个工具（插件的页面清单里没写）。');
    expect(pluginCallProblem('note not found')).toBeNull();
  });
});
