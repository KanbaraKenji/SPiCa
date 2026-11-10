#!/usr/bin/env node
// Install a plugin package (or folder) into Spica through Spica's MCP service,
// enable it, and show the tools it added. Optionally ask the agent to use it
// (--run) and turn it off again to check nothing is left behind (--disable-after).
//
// Ways to reach Spica:
//   default  node install.mjs <zip>
//          the running desktop Spica, when its local MCP connection is switched on:
//          it writes <userData>/mcp-http.json ({ url, tokenFile, pid }), e.g.
//          %APPDATA%\Spica\mcp-http.json. A build packaged under another name keeps
//          it in %APPDATA%\<app name>: pass --app <name>, or let the script find the
//          one running copy. --user-data <folder> or SPICA_USER_DATA point at a
//          folder directly.
//   HTTP   node install.mjs <zip> --http http://127.0.0.1:<port>/mcp --token-file <file>
//          (token also from the SPICA_MCP_TOKEN environment variable; never on the command line)
//   stdio  node install.mjs <zip> --stdio <backend.json> --spica <Spica source folder>
//          starts Spica's MCP service from source with that backend config
//          (needs the "@spica/plugins" extension in it, see references/connect.md)
//
// Other options:
//   --run "<message>"     send one message with spica_run and print the answer and the tools it called
//   --timeout <seconds>   for --run (default 180)
//   --disable-after       disable the plugin at the end and check its tools are gone
//   --no-enable           install only
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpClient, StdioClient } from './lib/mcp.mjs';

function parse(argv) {
  const o = { enable: true, disableAfter: false, timeout: 180 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 后面要跟一个值`);
      return v;
    };
    if (a === '--http') o.http = val();
    else if (a === '--token-file') o.tokenFile = val();
    else if (a === '--stdio') o.stdio = val();
    else if (a === '--spica') o.spica = val();
    else if (a === '--user-data') o.userData = val();
    else if (a === '--app') o.app = val();
    else if (a === '--run') o.run = val();
    else if (a === '--timeout') o.timeout = Number(val());
    else if (a === '--disable-after') o.disableAfter = true;
    else if (a === '--no-enable') o.enable = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) throw new Error(`不认识的选项 ${a}`);
    else o.path = a;
  }
  return o;
}

async function connect(o, log) {
  if (o.http) {
    const token = o.tokenFile ? (await readFile(o.tokenFile, 'utf8')).trim() : process.env.SPICA_MCP_TOKEN;
    if (!token) throw new Error('HTTP 连法要令牌：用 --token-file 指向令牌文件，或设环境变量 SPICA_MCP_TOKEN。');
    log(`连接 ${o.http}`);
    return new HttpClient({ url: o.http, token, timeoutMs: 60_000 });
  }
  if (o.stdio) {
    const spica = resolve(o.spica ?? process.env.SPICA_SOURCE ?? '.');
    const entry = join(spica, 'packages', 'core', 'src', 'host', 'mcp-main.ts');
    if (!existsSync(entry)) throw new Error(`在 ${spica} 里找不到 packages/core/src/host/mcp-main.ts。用 --spica 指向 Spica 源码文件夹（装好依赖的）。`);
    log(`启动 Spica 的 MCP 服务（${resolve(o.stdio)}）`);
    return new StdioClient({ command: process.execPath, args: [entry, '--config', resolve(o.stdio)], cwd: spica, timeoutMs: 60_000 });
  }
  const running = await desktopConnection(o.userData, o.app);
  if (running.ok) {
    log(`连接正在运行的 ${running.appName}（${running.url}）`);
    return new HttpClient({ url: running.url, token: running.token, timeoutMs: 60_000 });
  }
  const app = running.appName;
  throw new Error(
    `${running.reason}\n` +
      `办法：在 ${app} 的 设置 › 常规 › 开发者 里打开「允许本机脚本连接 ${app}」后再跑一次（应用改过名就加 --app <名字>）；或者在 设置 › 插件 里粘贴 zip 的完整路径手动安装；` +
      '开发时也可以用 --http 或 --stdio 连自己起的服务。见 references/connect.md。',
  );
}

const DEFAULT_APP = 'Spica';
const INFO_FILE = 'mcp-http.json';

/** Where Electron keeps per-user folders (one subfolder per app name). */
function appDataRoot() {
  if (process.platform === 'win32') return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
}

/**
 * The app's per-user folder (Electron userData). --user-data / SPICA_USER_DATA
 * win; otherwise <appData>/<app name>, default "Spica".
 */
export function userDataDir(override, app) {
  if (override) return resolve(override);
  if (process.env.SPICA_USER_DATA) return resolve(process.env.SPICA_USER_DATA);
  return join(appDataRoot(), app || DEFAULT_APP);
}

function alive(pid) {
  if (typeof pid !== 'number') return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

async function readInfo(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * A build packaged under another name and started without --app: look in the
 * per-user folders for a mcp-http.json that names its app and is still running.
 */
async function findRenamed() {
  const root = appDataRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === DEFAULT_APP) continue;
    const dir = join(root, e.name);
    if (!existsSync(join(dir, INFO_FILE))) continue;
    const info = await readInfo(join(dir, INFO_FILE));
    if (info && typeof info.appName === 'string' && typeof info.url === 'string' && alive(info.pid)) found.push({ dir, appName: info.appName });
  }
  return found;
}

/** Read <userData>/mcp-http.json written by the running desktop app. */
export async function desktopConnection(override, app) {
  let dir = userDataDir(override, app);
  if (!override && !app && !process.env.SPICA_USER_DATA && !existsSync(join(dir, INFO_FILE))) {
    const renamed = await findRenamed();
    if (renamed.length === 1) dir = renamed[0].dir;
    else if (renamed.length > 1) {
      return { ok: false, appName: DEFAULT_APP, reason: `有好几个应用开着本机连接：${renamed.map((r) => r.appName).join('、')}。用 --app <名字> 选一个。` };
    }
  }
  const file = join(dir, INFO_FILE);
  const info = await readInfo(file);
  const name = (typeof info?.appName === 'string' && info.appName) || app || DEFAULT_APP;
  const fail = (reason) => ({ ok: false, appName: name, reason });
  if (!info) return fail(`没找到正在运行、而且开了本机连接的 ${name}（${file} 不存在）。`);
  if (app && typeof info.appName === 'string' && info.appName.toLowerCase() !== app.toLowerCase()) {
    return fail(`${file} 是「${info.appName}」写的，不是你说的「${app}」。检查 --app 或 --user-data。`);
  }
  if (!alive(info.pid)) return fail(`${name} 上次开过本机连接，但现在没在运行。`);
  if (typeof info.url !== 'string' || typeof info.tokenFile !== 'string') return fail(`${file} 的内容不对（要有 url 和 tokenFile）。`);
  let token;
  try {
    token = (await readFile(info.tokenFile, 'utf8')).trim();
  } catch {
    return fail(`读不到令牌文件 ${info.tokenFile}。`);
  }
  return token ? { ok: true, appName: name, url: info.url, token } : fail('令牌文件是空的。');
}

const pluginTools = (names, plugin) => names.filter((n) => n.startsWith(`${plugin}__`) || n.startsWith(`${plugin}-`));

export async function install(o, log = console.log) {
  if (!o.path) throw new Error('要给插件包（.zip）或插件文件夹的路径。');
  const path = resolve(o.path);
  if (!existsSync(path)) throw new Error(`找不到 ${path}`);
  const client = await connect(o, log);
  const result = { steps: [] };
  const step = (ok, text) => {
    result.steps.push({ ok, text });
    log(`${ok ? '✓' : '✗'} ${text}`);
  };
  try {
    await client.initialize();
    const service = (await client.listTools()).map((t) => t.name);
    if (!service.includes('spica_plugin_install')) throw new Error('这个 Spica 的 MCP 服务没有插件命令（spica_plugin_install）：后台配置里要挂 @spica/plugins 扩展。');
    const listTools = async () => (await client.call('spica_list_tools')).map((t) => t.name);
    const before = await listTools();

    const d = await client.call('spica_plugin_install', { path, enable: o.enable }, 120_000);
    result.plugin = d;
    step(true, `已安装「${d.displayName}」${d.version}${d.previousVersion ? `（上一版 ${d.previousVersion} 保留，可回滚）` : ''}`);
    for (const i of d.issues ?? []) log(`  ！ ${i.where}：${i.message}`);
    if (!o.enable) return result;

    step(d.enabled === true, d.enabled ? '已启用' : '没有启用');
    const after = await listTools();
    const added = after.filter((t) => !before.includes(t));
    const own = pluginTools(after, d.name);
    result.tools = own;
    step(own.length > 0, `新增工具：${(added.length ? added : own).join('、') || '（没有）'}`);
    const broken = (d.servers ?? []).filter((s) => s.status !== 'running');
    if (broken.length) step(false, `没跑起来的进程：${broken.map((s) => `${s.id}（${s.status}${s.lastError ? `：${s.lastError}` : ''}）`).join('、')}`);
    if (d.views?.length) log(`  页面：${d.views.map((v) => `${v.title}（${v.placement}）`).join('、')}`);

    if (o.run) {
      log(`\n让 Agent 试用：${o.run}`);
      const run = await client.call('spica_run', { text: o.run, timeout_seconds: o.timeout }, (o.timeout + 30) * 1000);
      result.run = run;
      const used = run.toolCalls ?? [];
      const mine = pluginTools(used, d.name);
      step(mine.length > 0, `Agent 调了：${used.join('、') || '（没调工具）'}`);
      if (run.pending?.length) log(`  在等用户：${JSON.stringify(run.pending).slice(0, 300)}`);
      if (run.timedOut) step(false, `超过 ${o.timeout} 秒还没结束`);
      log(`  回答：${String(run.answer ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
    }

    if (o.disableAfter) {
      await client.call('spica_plugin_disable', { name: d.name });
      const left = pluginTools(await listTools(), d.name);
      step(left.length === 0, left.length === 0 ? '停用后插件的工具全部撤掉了' : `停用后还剩：${left.join('、')}`);
    }
    return result;
  } finally {
    await client.close();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let o;
  try {
    o = parse(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (o.help || !o.path) {
    console.log('用法：node install.mjs <插件包.zip 或文件夹> [--app <应用名> | --user-data <用户文件夹> | --http <地址> --token-file <文件> | --stdio <backend.json> --spica <源码文件夹>] [--run "一句话"] [--disable-after] [--no-enable]');
    process.exit(o.help ? 0 : 2);
  }
  try {
    const r = await install(o);
    process.exit(r.steps.every((s) => s.ok) ? 0 : 1);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
