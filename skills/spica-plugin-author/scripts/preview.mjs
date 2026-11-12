#!/usr/bin/env node
// Preview a plugin's page in an ordinary browser, without Spica: starts the
// plugin's MCP servers (mock mode by default), serves the plugin folder on
// 127.0.0.1 and injects a stand-in window.spica with the same rules as Spica
// (own tools only, only the view's permissions.tools, irreversible tools ask
// first). Colours follow ?theme=light|dark. For development only.
//
//   node preview.mjs <plugin folder> [--view <id>] [--port 4700] [--real] [--pick <path>]
//
// --pick <path>: window.spica.pickFolder / pickFile answer this path at once,
// as if the user picked it (for scripted runs: no dialog). Without it they ask
// with the browser's prompt; where there is none (automation), or it is
// dismissed, they answer null: the user cancelled. Each call logs a line in
// the page's console: [preview] pickFolder {"title":…} -> <path or null>.
import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAND_IN_ACCOUNT, StdioClient, pluginEnv } from './lib/mcp.mjs';
import { stripBom } from './lib/pack.mjs';

// Spica's two built-in skins (浅色 / 深色), the variables a page gets in Spica; radius, height and font below.
export const THEMES = {
  light: { bg: '#ffffff', surface: '#fafafa', fg: '#191919', muted: '#666666', border: '#fbfbfb', accent: '#2f7de1', danger: '#dc2626', control: '#f2f2f2', 'control-hover': '#e5e5e5', input: '#ffffff', 'border-strong': '#cecece', placeholder: '#878787', 'on-accent': '#ffffff' },
  dark: { bg: '#191919', surface: '#222222', fg: '#efefef', muted: '#9c9c9c', border: '#222222', accent: '#62a9ff', danger: '#f87171', control: '#3b3b3b', 'control-hover': '#454545', input: '#303030', 'border-strong': '#474747', placeholder: '#878787', 'on-accent': '#ffffff' },
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };

export async function startPreview(dir, opts = {}) {
  const root = resolve(dir);
  const readJson = async (p) => JSON.parse(stripBom(await readFile(p, 'utf8')));
  const m = await readJson(join(root, 'manifest.json'));
  const viewFiles = existsSync(join(root, 'views')) ? (await readdir(join(root, 'views'))).filter((f) => f.endsWith('.json')) : [];
  if (viewFiles.length === 0) throw new Error('这个插件没有页面（views/*.json）。');
  const viewId = opts.view ?? viewFiles[0].slice(0, -5);
  const view = await readJson(join(root, 'views', `${viewId}.json`));

  // Start the servers the way Spica does.
  const data = await mkdtemp(join(tmpdir(), 'spica-preview-'));
  const tools = new Map(); // bare name → client
  const clients = [];
  for (const kind of ['mcp', 'services']) {
    if (!existsSync(join(root, kind))) continue;
    for (const f of await readdir(join(root, kind))) {
      if (!f.endsWith('.json')) continue;
      const s = await readJson(join(root, kind, f));
      const entry = resolve(root, s.entry);
      const client = new StdioClient({
        command: s.runtime === 'node' ? process.execPath : entry,
        args: s.runtime === 'node' ? [entry, ...(s.args ?? [])] : (s.args ?? []),
        cwd: root,
        // as in Spica: the server's own limits; progress restarts the wait
        ...(typeof s.timeout_seconds === 'number' ? { timeoutMs: s.timeout_seconds * 1000 } : {}),
        ...(typeof s.max_call_seconds === 'number' ? { maxCallMs: s.max_call_seconds * 1000 } : {}),
        env: pluginEnv({ ...(s.env ?? {}), SPICA_MOCK: opts.real ? '0' : '1', SPICA_PLUGIN_NAME: m.name, SPICA_PLUGIN_VERSION: m.version, SPICA_PLUGIN_DIR: root, SPICA_PLUGIN_DATA: join(data, f), SPICA_USER_ACCOUNT: STAND_IN_ACCOUNT }),
      });
      await client.initialize();
      for (const t of await client.listTools()) if (!tools.has(t.name)) tools.set(t.name, client);
      clients.push(client);
    }
  }
  const allowed = view.permissions?.tools ?? [...tools.keys()];
  const irreversible = m.permissions?.irreversible ?? [];

  const bridge = (mode) => `<script>
(() => {
  const vars = ${JSON.stringify(THEMES[mode])};
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty('--spica-' + k, v);
  root.style.setProperty('--spica-font', 'system-ui, "Segoe UI", sans-serif');
  root.style.setProperty('--spica-radius', '8px');
  root.style.setProperty('--spica-control-h', '28px');
  root.dataset.theme = '${mode}';
  const listeners = new Set();
  const picked = ${JSON.stringify(opts.pick || null).replace(/</g, '\\u003c')};
  const pick = async (name, o, ask) => {
    const args = {};
    for (const k of ['title', 'defaultPath', 'extensions']) if (o && o[k] !== undefined) args[k] = o[k];
    let v = picked;
    if (v === null) {
      try {
        v = typeof window.prompt === 'function' ? window.prompt(args.title || ask, args.defaultPath || '') : null;
      } catch {
        v = null;
      }
      if (!v) v = null;
    }
    console.log('[preview] ' + name + ' ' + JSON.stringify(args) + ' -> ' + (v === null ? 'null' : v));
    return v;
  };
  const post = (body) => fetch('/__spica/call', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
  window.spica = {
    theme: { mode: '${mode}' },
    async callTool(tool, args) {
      let r = await post({ tool, args });
      if (r.isError && r.content.startsWith('[CONFIRM_REQUIRED]')) {
        if (!window.confirm(${JSON.stringify(m.display_name ?? m.name)} + ' 要执行 ' + tool + '，确认吗？')) return r;
        r = await post({ tool, args, confirmed: true });
      }
      return r;
    },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    openFile(path) { console.log('[preview] openFile', path); },
    // No system dialog or Explorer here: the pickers answer --pick, else ask in the browser; openFolder only logs.
    pickFolder: (o) => pick('pickFolder', o, '选择文件夹（预览：输入完整路径）'),
    pickFile: (o) => pick('pickFile', o, '选择文件（预览：输入完整路径）'),
    async openFolder(path) { console.log('[preview] openFolder', path); return null; },
    notify(text, o) { console.log('[preview] notify', o && o.kind || 'info', text); },
  };
})();
</script>`;

  const inside = (rel) => {
    const abs = resolve(root, rel);
    const r = relative(root, abs);
    return !r || r.startsWith('..') || isAbsolute(r) || r.split(sep).includes('..') ? undefined : abs;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === '/__spica/call' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const { tool, args, confirmed } = JSON.parse(body);
        const send = (v) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
        const client = tools.get(tool);
        if (!client) return send({ content: `[TOOL_NOT_FOUND] 插件没有 ${tool} 这个工具。`, isError: true });
        if (!allowed.includes(tool)) return send({ content: `[TOOL_NOT_ALLOWED] 这个页面没有声明可以调 ${tool}（views/${viewId}.json 的 permissions.tools）。`, isError: true });
        if (irreversible.includes(tool) && confirmed !== true) return send({ content: '[CONFIRM_REQUIRED] 这个操作不可撤销，需要确认。', isError: true });
        const r = await client.callToolRaw(tool, args ?? {});
        const content = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        let data;
        try {
          data = JSON.parse(content);
        } catch {
          data = undefined;
        }
        return send({ content, isError: !!r.isError, ...(data !== undefined ? { data } : {}) });
      }
      // The page's relative links (style.css, app.js) must resolve next to it.
      if (url.pathname === '/') return res.writeHead(302, { location: `/${view.entry}${url.search}` }).end();
      const rel = decodeURIComponent(url.pathname.slice(1));
      const abs = inside(rel);
      if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return res.writeHead(404).end('not found');
      let body = await readFile(abs);
      const type = TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream';
      if (type === 'text/html') {
        const mode = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
        body = body.toString('utf8').replace(/<head([^>]*)>/i, (h) => `${h}\n${bridge(mode)}`);
      }
      res.writeHead(200, {
        'content-type': `${type}; charset=utf-8`,
        // Same limits as Spica's sandbox: only this plugin's files, inline styles allowed.
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500).end(String(err?.message ?? err));
    }
  });
  await new Promise((r) => server.listen(opts.port ?? 4700, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/${view.entry}`,
    tools: allowed,
    async close() {
      await new Promise((r) => server.close(r));
      for (const c of clients) await c.close();
      await rm(data, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const dir = args.find((a, i) => !a.startsWith('--') && !['--view', '--port', '--pick'].includes(args[i - 1]));
  if (!dir) {
    console.log('用法：node preview.mjs <插件文件夹> [--view 视图id] [--port 4700] [--real] [--pick 完整路径]');
    process.exit(2);
  }
  try {
    const p = await startPreview(dir, { view: opt('--view'), port: opt('--port') ? Number(opt('--port')) : undefined, real: args.includes('--real'), pick: opt('--pick') });
    console.log(`预览：${p.url}（暗色加 ?theme=dark）`);
    console.log(`页面能调的工具：${p.tools.join('、')}`);
    console.log(opt('--pick') ? `选文件夹 / 选文件：直接回 ${opt('--pick')}（--pick）` : '选文件夹 / 选文件：浏览器里输入路径；自动化里弹不出来，就当用户取消（回 null）。要固定回一个路径，加 --pick <完整路径>。');
    console.log(`用户账号（SPICA_USER_ACCOUNT）：${STAND_IN_ACCOUNT}（虚构的；装进 Spica 后是用户自己的）`);
    console.log('按 Ctrl+C 结束。');
    const stop = async () => {
      await p.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
