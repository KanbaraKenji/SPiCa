import { describe, expect, it } from 'vitest';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { BRIDGE_JS, contentType, createPluginPicker, injectIntoPage, pageCsp, parsePluginUrl, pickDialogOptions, pickStartPath, pluginThemeVars, themeCss, type PickDialogOptions } from './plugin-views';
import { pluginCallId, pluginCallProblem } from '../shared/plugin-view';
import { DARK_SKIN, deriveTokens } from '../shared/skin';

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
    expect(Object.keys(vars).sort()).toEqual(
      [
        '--spica-accent',
        '--spica-bg',
        '--spica-border',
        '--spica-danger',
        '--spica-fg',
        '--spica-font',
        '--spica-muted',
        '--spica-radius',
        '--spica-surface',
        '--spica-control',
        '--spica-control-hover',
        '--spica-input',
        '--spica-border-strong',
        '--spica-placeholder',
        '--spica-on-accent',
        '--spica-control-h',
      ].sort(),
    );
    expect(vars['--spica-fg']).toBe('#ecebe5');
    // The controls take the skin's own (the dark skin: Spica's buttons, fields and main-button text).
    const dark = pluginThemeVars(deriveTokens(DARK_SKIN), 'Segoe UI');
    expect([dark['--spica-control'], dark['--spica-input'], dark['--spica-border-strong'], dark['--spica-on-accent'], dark['--spica-control-h']]).toEqual(['#3b3b3b', '#303030', '#474747', '#ffffff', '28px']);
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

describe('a page’s own script after the bridge', () => {
  it('may declare its own top-level spica (const spica = window.spica), as the examples and the template do', () => {
    // The page's window is the global of its scripts, as in a browser.
    const ctx = createContext({ document: { documentElement: { dataset: {}, style: {} } }, console });
    runInContext('var window = this; window.parent = { postMessage() {} }; window.addEventListener = function () {};', ctx);
    runInContext(BRIDGE_JS, ctx);
    expect(runInContext("const spica = window.spica; typeof spica.callTool + ' ' + typeof spica.pickFolder", ctx)).toBe('function function');
  });
});

describe('the system’s pickers for a page (window.spica.pickFolder / pickFile)', () => {
  const shown: PickDialogOptions[] = [];
  /** A stand-in dialog: answers what `answer` says, after `wait` resolves when given. */
  const dialog =
    (answer: { canceled: boolean; filePaths: string[] }, wait?: Promise<void>) =>
    async (opts: PickDialogOptions) => {
      shown.push(opts);
      await wait;
      return answer;
    };

  it('picked: the full path; cancelled: null', async () => {
    shown.length = 0;
    const picked = createPluginPicker(dialog({ canceled: false, filePaths: ['D:\\Notes'] }));
    expect(await picked({ kind: 'folder', plugin: 'Notes (example)', title: '选择笔记文件夹', defaultPath: 'D:\\Old' })).toBe('D:\\Notes');
    expect(shown[0]).toEqual({ title: 'Notes (example) · 选择笔记文件夹', defaultPath: 'D:\\Old', properties: ['openDirectory', 'createDirectory'] });
    const cancelled = createPluginPicker(dialog({ canceled: true, filePaths: [] }));
    expect(await cancelled({ kind: 'folder', plugin: 'Notes (example)' })).toBeNull();
    const broken = createPluginPicker(async () => {
      throw new Error('no window');
    });
    expect(await broken({ kind: 'file', plugin: 'x' })).toBeNull();
  });

  it('one dialog at a time: a second ask while one is open is answered null; after it closes, asking works again', async () => {
    shown.length = 0;
    let close!: () => void;
    const pick = createPluginPicker(dialog({ canceled: false, filePaths: ['C:\\A'] }, new Promise<void>((r) => (close = r))));
    const first = pick({ kind: 'folder', plugin: 'p' });
    expect(await pick({ kind: 'file', plugin: 'q' })).toBeNull();
    close();
    expect(await first).toBe('C:\\A');
    expect(await pick({ kind: 'folder', plugin: 'p' })).toBe('C:\\A');
    expect(shown).toHaveLength(2);
  });

  it('a file: one file, of the kinds the page names; the development answer skips the dialog', async () => {
    expect(pickDialogOptions({ kind: 'file', plugin: 'Docs', extensions: ['.MD', 'txt', '.md', 'a b', '', 7 as unknown as string] })).toEqual({
      title: 'Docs · 选择文件',
      properties: ['openFile'],
      filters: [{ name: '.md .txt', extensions: ['md', 'txt'] }],
    });
    expect(pickDialogOptions({ kind: 'folder', plugin: '', extensions: ['.md'] })).toEqual({ title: '选择文件夹', properties: ['openDirectory', 'createDirectory'] });
    shown.length = 0;
    const dev = createPluginPicker(dialog({ canceled: true, filePaths: [] }), (kind) => (kind === 'file' ? 'E:\\x.md' : null));
    expect(await dev({ kind: 'file', plugin: 'p' })).toBe('E:\\x.md');
    expect(shown).toEqual([]);
  });

  it('starts only on a local drive: network and odd paths are left out', () => {
    for (const ok of ['C:\\Users\\me', 'd:/data', 'E:\\']) expect(pickStartPath(ok)).toBe(ok);
    for (const bad of ['\\\\server\\share', '//server/share', '\\\\?\\C:\\x', 'C:\\\\server', 'relative\\x', 'C:', 'C:\\a\nb', 'C:\\' + 'x'.repeat(300), 7, undefined]) {
      expect(pickStartPath(bad)).toBeUndefined();
    }
    expect(pickDialogOptions({ kind: 'folder', plugin: 'p', defaultPath: '\\\\attacker\\share' })).not.toHaveProperty('defaultPath');
  });

  it('the page’s bridge sends only the title, start and kinds', () => {
    const posted: { call?: string; args?: unknown }[] = [];
    const win: Record<string, unknown> = { parent: { postMessage: (m: object) => posted.push(m) }, addEventListener: () => undefined };
    runInNewContext(BRIDGE_JS, { window: win, document: { documentElement: { dataset: {}, style: {} } }, console });
    const spica = win.spica as { pickFolder(o?: unknown): Promise<unknown>; pickFile(o?: unknown): Promise<unknown> };
    void spica.pickFolder({ title: 'T', defaultPath: 'C:\\x', other: 1 });
    void spica.pickFile({ extensions: ['.md', 3] });
    void spica.pickFolder();
    expect(posted.filter((m) => m.call?.startsWith('pick')).map((m) => [m.call, m.args])).toEqual([
      ['pickFolder', { title: 'T', defaultPath: 'C:\\x' }],
      ['pickFile', { extensions: ['.md', '3'] }],
      ['pickFolder', {}],
    ]);
  });
});
