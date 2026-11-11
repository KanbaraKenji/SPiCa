// Plugin pages (views/<id>.json): served from the plugin's own folder through
// spica-plugin://<plugin>/<path>, shown in a sandboxed frame. The entry page
// gets the current theme (CSS variables) and a small bridge (window.spica)
// that talks to the window by postMessage; the window checks which frame
// (so which plugin) every call comes from. Pure parts here, glue in index.ts.

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
  Object.defineProperty(window, 'spica', { value: Object.freeze(spica), writable: false, configurable: false });
  post({ call: 'ready', id: 0 });
})();
`;
