#!/usr/bin/env node
// Install a plugin package (or folder) into Spica through Spica's MCP service,
// enable it, and show the tools it added. Optionally ask the agent to use it
// (--run) and turn it off again to check nothing is left behind (--disable-after).
//
// Ways to reach Spica:
//   default  node install.mjs <zip>
//          the running desktop Spica, when its local MCP connection is switched on:
//          it writes <userData>/mcp-http.json ({ url, tokenFile, pid }), e.g.
//          %APPDATA%\Spica\mcp-http.json. --user-data <folder> or SPICA_USER_DATA
//          point elsewhere.
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
import { readFile } from 'node:fs/promises';
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
  const running = await desktopConnection(o.userData);
  if (running.ok) {
    log(`连接正在运行的 Spica（${running.url}）`);
    return new HttpClient({ url: running.url, token: running.token, timeoutMs: 60_000 });
  }
  throw new Error(
    `${running.reason}\n` +
      '办法：在 Spica 的 设置 › 常规 › 开发者 里打开「允许本机脚本连接 Spica（开发者）」后再跑一次；或者在 设置 › 插件 里粘贴 zip 的完整路径手动安装；' +
      '开发时也可以用 --http 或 --stdio 连自己起的服务。见 references/connect.md。',
  );
}

/** Spica's per-user folder (Electron userData for the app named "Spica"). */
export function userDataDir(override) {
  if (override) return resolve(override);
  if (process.env.SPICA_USER_DATA) return resolve(process.env.SPICA_USER_DATA);
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Spica');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Spica');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Spica');
}

/** Read <userData>/mcp-http.json written by the running desktop app. */
export async function desktopConnection(override) {
  const dir = userDataDir(override);
  const file = join(dir, 'mcp-http.json');
  let info;
  try {
    info = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return { ok: false, reason: `没找到正在运行、而且开了本机连接的 Spica（${file} 不存在）。` };
  }
  if (typeof info.pid === 'number') {
    try {
      process.kill(info.pid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') return { ok: false, reason: 'Spica 上次开过本机连接，但现在没在运行。' };
    }
  }
  if (typeof info.url !== 'string' || typeof info.tokenFile !== 'string') return { ok: false, reason: `${file} 的内容不对（要有 url 和 tokenFile）。` };
  let token;
  try {
    token = (await readFile(info.tokenFile, 'utf8')).trim();
  } catch {
    return { ok: false, reason: `读不到令牌文件 ${info.tokenFile}。` };
  }
  return token ? { ok: true, url: info.url, token } : { ok: false, reason: '令牌文件是空的。' };
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
    console.log('用法：node install.mjs <插件包.zip 或文件夹> [--user-data <Spica 用户文件夹> | --http <地址> --token-file <文件> | --stdio <backend.json> --spica <源码文件夹>] [--run "一句话"] [--disable-after] [--no-enable]');
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
