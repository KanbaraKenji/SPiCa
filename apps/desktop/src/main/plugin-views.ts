// Plugin pages (views/<id>.json): served from the plugin's own folder through
// spica-plugin://<plugin>/<path>, shown in a sandboxed frame. The entry page
// gets the current theme (CSS variables) and a small bridge (window.spica)
// that talks to the window by postMessage; the window checks which frame
// (so which plugin) every call comes from. Pure parts here, glue in index.ts.

import { localDrivePath, type PluginPickRequest } from '../shared/plugin-view';

export const PLUGIN_SCHEME = 'spica-plugin';
export { pluginThemeVars } from '../shared/plugin-view';

export function themeCss(vars: Record<string, string>, mode: 'light' | 'dark'): string {
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  return `:root {\n${body}\n  color-scheme: ${mode};\n}\nhtml, body { background: var(--spica-bg); color: var(--spica-fg); font-family: var(--spica-font); }\n`;
}

/** A page may load only its own plugin's files; no network, no other plugins. */
export function pageCsp(plugin: string): string {
  const own = `${PLUGIN_SCHEME}://${plugin}`;
  return [
    "default-src 'none'",
    `script-src ${own}`,
    `style-src ${own} 'unsafe-inline'`,
    `img-src ${own} data:`,
    `font-src ${own}`,
    `media-src ${own}`,
    "connect-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self' file: http://localhost:* http://127.0.0.1:*",
  ].join('; ');
}

/** Theme first (no flash of other colors), then the bridge, before anything of the page. */
export function injectIntoPage(html: string, plugin: string): string {
  const base = `${PLUGIN_SCHEME}://${plugin}/__spica`;
  const tags = `<link rel="stylesheet" href="${base}/theme.css"><script src="${base}/bridge.js"></script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tags + html.slice(head.index + head[0].length);
  return tags + html;
}

/** Which file a spica-plugin URL asks for; null when it is not one. */
export function parsePluginUrl(url: string): { plugin: string; path: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== `${PLUGIN_SCHEME}:` || !u.hostname) return null;
    const path = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    if (!path || path.split('/').some((p) => p === '..')) return null;
    return { plugin: u.hostname, path };
  } catch {
    return null;
  }
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
};

export function contentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

// ---------- the system's pickers for a page (window.spica.pickFolder / pickFile) ----------
// A page in its sandbox learns a full path on this computer only because the user picked it in the system's
// dialog: no declaration in the manifest, nothing read or written (the page hands the path to its own tools,
// whose hooks and confirmations apply as for any call). The window does not offer it to preview pages.

/** What the dialog is shown with (Electron's OpenDialogOptions, the part used here). */
export interface PickDialogOptions {
  title: string;
  defaultPath?: string;
  properties: ('openDirectory' | 'openFile' | 'createDirectory')[];
  filters?: { name: string; extensions: string[] }[];
}

/** Where the dialog may start: a full path on a local drive (localDrivePath); anything else is left out. */
export const pickStartPath = localDrivePath;

/** File kinds a page names (".md" or "md"): lower case, without the dot, at most 20; others left out. */
export function pickExtensions(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const e = x.trim().toLowerCase().replace(/^\./, '');
    if (/^[a-z0-9]{1,10}$/.test(e)) out.add(e);
    if (out.size >= 20) break;
  }
  return [...out];
}

/** The dialog for a page's request: its plugin's name first in the title, so the user knows who asks. */
export function pickDialogOptions(req: PluginPickRequest): PickDialogOptions {
  const own = typeof req.title === 'string' ? req.title.trim().slice(0, 60) : '';
  const plugin = String(req.plugin ?? '').trim().slice(0, 40);
  const what = own || (req.kind === 'file' ? '选择文件' : '选择文件夹');
  const start = pickStartPath(req.defaultPath);
  const opts: PickDialogOptions = {
    title: plugin ? `${plugin} · ${what}` : what,
    ...(start ? { defaultPath: start } : {}),
    properties: req.kind === 'file' ? ['openFile'] : ['openDirectory', 'createDirectory'],
  };
  const ext = req.kind === 'file' ? pickExtensions(req.extensions) : [];
  if (ext.length) opts.filters = [{ name: ext.map((e) => `.${e}`).join(' '), extensions: ext }];
  return opts;
}

/**
 * The pickers of all plugin pages: one dialog at a time (a second ask while one is open is answered null,
 * as a cancel), shown by `show` (over the window, in index.ts). `answered`: development only, a path given
 * without the dialog (SPICA_PICK_FOLDER / SPICA_PICK_FILES), so test scripts never drive one.
 */
export function createPluginPicker(
  show: (opts: PickDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>,
  answered: (kind: PluginPickRequest['kind']) => string | null = () => null,
): (req: PluginPickRequest) => Promise<string | null> {
  let open = false;
  return async (req) => {
    const kind = req?.kind === 'file' ? 'file' : 'folder';
    const given = answered(kind);
    if (given) return given;
    if (open) return null;
    open = true;
    try {
      const r = await show(pickDialogOptions({ ...req, kind }));
      return r.canceled ? null : (r.filePaths[0] ?? null);
    } catch {
      return null;
    } finally {
      open = false;
    }
  };
}

/**
 * window.spica inside a plugin page. Talks to the window only (parent), which
 * answers for this frame's plugin. Kept as plain ES2019 so any page can use it.
 */
export const BRIDGE_JS = `(() => {
  'use strict';
  if (window.parent === window) {
    window.spica = undefined;
    return;
  }
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  const post = (msg) => window.parent.postMessage(Object.assign({ __spica: 1 }, msg), '*');
  const call = (method, args) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      post({ call: method, id, args: args || {} });
    });
  const pickArgs = (opts) => {
    const o = {};
    if (opts && typeof opts.title === 'string') o.title = opts.title;
    if (opts && typeof opts.defaultPath === 'string') o.defaultPath = opts.defaultPath;
    return o;
  };
  const theme = { mode: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light' };
  const applyTheme = (ev) => {
    const root = document.documentElement;
    for (const k of Object.keys(ev.vars || {})) root.style.setProperty(k, ev.vars[k]);
    root.style.colorScheme = ev.mode;
    root.dataset.theme = ev.mode;
    theme.mode = ev.mode;
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || d.__spica !== 1) return;
    if (d.reply) {
      const p = pending.get(d.reply);
      if (!p) return;
      pending.delete(d.reply);
      if (d.error) p.reject(new Error(d.error));
      else p.resolve(d.result);
    } else if (d.event) {
      if (d.event.type === 'theme') applyTheme(d.event);
      for (const fn of listeners) {
        try {
          fn(d.event);
        } catch (err) {
          console.error(err);
        }
      }
    }
  });
  const spica = {
    get theme() {
      return { mode: theme.mode };
    },
    callTool: (tool, args) => call('callTool', { tool: String(tool), args: args || {} }),
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    openFile: (path) => call('openFile', { path: String(path) }),
    // The system's pickers: the full path the user picked, or null when they cancelled. Only the path:
    // reading or writing it is the plugin's own tools' work.
    pickFolder: (opts) => call('pickFolder', pickArgs(opts)),
    pickFile: (opts) => call('pickFile', Object.assign(pickArgs(opts), opts && Array.isArray(opts.extensions) ? { extensions: opts.extensions.map(String) } : {})),
    // A folder on a local drive in the system's file manager (Explorer): only opened, nothing run or read.
    openFolder: (path) => call('openFolder', { path: String(path) }),
    notify: (text, opts) => call('notify', { text: String(text), kind: opts && opts.kind === 'error' ? 'error' : 'info' }),
    // A preview page (placement preview): its one file, and saying when it is drawn or why it cannot be.
    // The window answers these only for a frame it opened as a preview.
    preview: Object.freeze({
      file: () => call('previewFile'),
      ready: () => {
        drawn = true;
        return call('previewReady');
      },
      fail: (text) => {
        drawn = true;
        return call('previewFail', { text: String(text) });
      },
    }),
  };
  // Until the page says it is drawn, an error of its script means it cannot show the file. Not the browser's
  // ResizeObserver loop notice: it is no error of the page (a page fitting itself to the panel raises it).
  let drawn = false;
  const failed = (text) => {
    if (drawn || /^ResizeObserver loop/.test(String(text))) return;
    post({ call: 'previewError', id: 0, args: { text: String(text).slice(0, 300) } });
  };
  window.addEventListener('error', (e) => failed(e.message || 'error'));
  window.addEventListener('unhandledrejection', (e) => failed((e.reason && e.reason.message) || e.reason || 'error'));
  // Configurable: a page's own top-level "const spica = window.spica" (the examples', the template's) is then
  // allowed; on a property that cannot be configured the browser refuses the whole script ("Identifier
  // 'spica' has already been declared"). The page can only change its own copy, never what Spica answers.
  Object.defineProperty(window, 'spica', { value: Object.freeze(spica), writable: false, configurable: true });
  post({ call: 'ready', id: 0 });
})();
`;
