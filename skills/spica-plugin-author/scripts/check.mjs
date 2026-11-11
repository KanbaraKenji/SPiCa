#!/usr/bin/env node
// Check a Spica plugin folder, run its tests and pack it.
//
//   node check.mjs <plugin folder> [--out <folder>] [--no-tests] [--no-start] [--no-pack]
//
// 1. Light checks of manifest.json and the parts (same rules as Spica, plain
//    messages). Spica checks again on install and has the final word.
// 2. Starts every MCP server in mock mode and lists its tools: names in
//    permissions.irreversible, the mail declaration and page permissions must
//    exist; every tool needs a description and an input schema.
// 3. Looks for things that must not ship: keys, tokens, private keys; and for
//    environment variables the code reads that Spica will not pass to it.
// 4. Runs `node --test` when the plugin has a test/ folder.
// 5. Packs <name>-<version>.zip (honouring .spicaignore) into dist/ (or --out)
//    with a .sha256 file next to it.
// Exit code 0 = ready to install, 1 = something to fix.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_INHERIT_ENV, StdioClient, pluginEnv } from './lib/mcp.mjs';
import { packageFiles, sha256, stripBom, writeZip } from './lib/pack.mjs';

const NAME = /^[a-z][a-z0-9-]{1,23}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const HOOK_KINDS = ['inject', 'beforeRequest', 'afterResponse', 'beforeTool', 'afterTool'];
const CONSOLE_SCRIPTS = /\.(cmd|bat|ps1|vbs)$/i;
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, '像模型 API key 的字符串（sk-…）'],
  [/\bAKIA[0-9A-Z]{16}\b/, '像云服务访问密钥的字符串'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, '像 GitHub 令牌的字符串'],
  [/\b(?:api[_-]?key|secret|password|passwd|token)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i, '写死的密码 / 密钥 / 令牌'],
];
// Variables Spica sets for a plugin server besides the whitelist: its own SPICA_* and the
// network settings (proxy, trusted certificates).
const APP_SET_ENV = /^(SPICA_|NODE_EXTRA_CA_CERTS$|NODE_USE_SYSTEM_CA$|NODE_USE_ENV_PROXY$|SSL_CERT_FILE$|REQUESTS_CA_BUNDLE$|CURL_CA_BUNDLE$|ELECTRON_RUN_AS_NODE$|NODE_ENV$)/;
const ENV_READS = /process\.env(?:\.([A-Za-z_]\w*)|\[\s*['"]([A-Za-z_]\w*)['"]\s*\])|os\.(?:environ(?:\.get\(\s*|\[\s*)|getenv\(\s*)['"]([A-Za-z_]\w*)['"]/g;
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;

export async function check(dir, opts = {}) {
  const root = resolve(dir);
  const report = { root, errors: [], warnings: [], ok: [], tools: {} };
  const err = (where, msg) => report.errors.push(`${where}：${msg}`);
  const warn = (where, msg) => report.warnings.push(`${where}：${msg}`);
  const inside = (rel) => {
    if (typeof rel !== 'string' || !rel || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return undefined;
    const abs = resolve(root, rel);
    const r = relative(root, abs);
    return !r || r.startsWith('..') || isAbsolute(r) || r.split(sep).includes('..') ? undefined : abs;
  };
  const readJson = async (rel) => JSON.parse(stripBom(await readFile(join(root, rel), 'utf8')));
  const list = async (rel) => (existsSync(join(root, rel)) ? readdir(join(root, rel), { withFileTypes: true }) : []);

  // ---- manifest ----
  let m;
  try {
    m = await readJson('manifest.json');
  } catch (e) {
    err('manifest.json', existsSync(join(root, 'manifest.json')) ? `不是合法的 JSON（${e.message}）` : '没有这个文件，这不是插件文件夹');
    return report;
  }
  if (m.manifest_version !== 1) err('manifest.json', 'manifest_version 要写 1');
  if (!NAME.test(m.name ?? '')) err('manifest.json', 'name 只能用小写字母、数字和 -，以字母开头，2–24 个字符');
  if (!SEMVER.test(m.version ?? '')) err('manifest.json', 'version 要写三段数字，例如 0.1.0');
  if (typeof m.description !== 'string' || !m.description.trim()) err('manifest.json', '缺少 description（一句话说插件做什么）');
  if (typeof m.display_name !== 'string' || !m.display_name.trim()) warn('manifest.json', '没有 display_name，界面上会显示 name');
  const author = typeof m.author === 'string' ? m.author : m.author?.name;
  if (typeof author !== 'string' || !author.trim()) err('manifest.json', 'author 要写作者或团队名：{ "name": "…" }');
  if (typeof m.license !== 'string') warn('manifest.json', '没有 license（SPDX 写法，例如 "Apache-2.0"）');
  if (typeof m.compatibility?.spica !== 'string') warn('manifest.json', 'compatibility.spica 最好写上，例如 ">=0.1.0"');
  const perm = m.permissions ?? {};
  if (!m.permissions) warn('manifest.json', '没有 permissions：默认什么都不声明，用到钩子或不可逆工具时要写');
  if (perm.workspace !== undefined && !['none', 'read', 'write'].includes(perm.workspace)) err('manifest.json', 'permissions.workspace 只能是 none、read 或 write');
  if (perm.model !== undefined) {
    const pm = perm.model;
    if (typeof pm !== 'object' || pm === null || Array.isArray(pm)) err('manifest.json', 'permissions.model 应该是对象，例如 { "reason": "给笔记写摘要", "max_usd_per_day": 0.2 }');
    else {
      if (typeof pm.reason !== 'string' || !pm.reason.trim()) err('manifest.json', 'permissions.model.reason 要写一句为什么要用模型（安装和启用时给用户看）');
      else if (pm.reason.trim().length > 200) err('manifest.json', 'permissions.model.reason 写一句话就够，不要超过 200 个字');
      const max = pm.max_usd_per_day;
      if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max) || max <= 0)) err('manifest.json', 'permissions.model.max_usd_per_day 是每天最多花多少美元，写一个大于 0 的数');
      else if (typeof max === 'number' && max > 5) warn('manifest.json', `permissions.model.max_usd_per_day 是 ${max}，每天偏高，确认一下`);
    }
  }
  const irreversible = Array.isArray(perm.irreversible) ? perm.irreversible : [];
  if (perm.irreversible !== undefined && !Array.isArray(perm.irreversible)) err('manifest.json', 'permissions.irreversible 要写成工具名列表');
  const hookKinds = Array.isArray(perm.hooks) ? perm.hooks : [];
  for (const k of hookKinds) if (!HOOK_KINDS.includes(k)) err('manifest.json', `permissions.hooks 里的 ${k} 不是钩子类型（可用：${HOOK_KINDS.join('、')}）`);
  if (m.mock?.supported === true && !existsSync(join(root, 'mock'))) warn('manifest.json', 'mock.supported 是 true，但没有 mock/ 文件夹');
  if (m.mock?.supported !== true) warn('manifest.json', '没有支持模拟模式（mock.supported）：在家里或外网连不上服务时，插件就没法试');

  // ---- servers ----
  const servers = [];
  for (const kind of ['mcp', 'services']) {
    for (const e of await list(kind)) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const where = `${kind}/${e.name}`;
      let s;
      try {
        s = await readJson(`${kind}/${e.name}`);
      } catch {
        err(where, '不是合法的 JSON');
        continue;
      }
      if (s.runtime === 'python') {
        err(where, 'Python 这一版请打成 .exe，写 "runtime": "binary"');
        continue;
      }
      if (s.runtime !== 'node' && s.runtime !== 'binary') {
        err(where, 'runtime 只能是 node 或 binary');
        continue;
      }
      const entry = inside(s.entry);
      if (!entry) err(where, 'entry 要写插件文件夹里的相对路径');
      else if (CONSOLE_SCRIPTS.test(entry)) err(where, '不能用 .cmd / .bat / .ps1 / .vbs 启动（会弹黑窗口）');
      else if (!existsSync(entry)) err(where, `entry 指向的 ${s.entry} 不存在`);
      else servers.push({ id: basename(e.name, '.json'), kind, runtime: s.runtime, entry, args: Array.isArray(s.args) ? s.args.map(String) : [], env: s.env ?? {}, launchName: '' });
      for (const k of Object.keys(s.env ?? {})) if (/^SPICA_/i.test(k)) err(where, `env 里不能自己设 ${k}（SPICA_ 开头的由 Spica 设）`);
      const cap = s.max_call_seconds;
      if (cap !== undefined && (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0)) err(where, 'max_call_seconds 要写大于 0 的秒数（一次调用最长多久，哪怕一直在报进度）');
    }
  }
  const mcpCount = servers.filter((s) => s.kind === 'mcp').length;
  for (const s of servers) s.launchName = s.kind === 'mcp' && mcpCount === 1 ? m.name : `${m.name}-${s.id}`;

  // ---- skills, commands, hooks, views ----
  for (const e of await list('skills')) {
    if (!e.isDirectory()) continue;
    const p = join(root, 'skills', e.name, 'SKILL.md');
    if (!existsSync(p)) err(`skills/${e.name}`, '缺少 SKILL.md');
    else if (!/^---[\s\S]*?\bdescription:\s*\S[\s\S]*?---/.test(stripBom(await readFile(p, 'utf8')))) err(`skills/${e.name}/SKILL.md`, '开头的 --- 块里要有 description（写清什么时候用）');
  }
  for (const e of await list('commands')) {
    if (e.isFile() && e.name.endsWith('.md') && !/^---[\s\S]*?\bdescription:\s*\S[\s\S]*?---/.test(stripBom(await readFile(join(root, 'commands', e.name), 'utf8')))) {
      warn(`commands/${e.name}`, '开头的 --- 块里最好写 description，输入框提示用它');
    }
  }
  const hookFiles = (await list('hooks')).filter((e) => e.isFile());
  for (const e of hookFiles) if (!/\.(m?js)$/.test(e.name)) err(`hooks/${e.name}`, '钩子只收 .js / .mjs（TypeScript 先编译）');
  if (hookFiles.length > 0 && hookKinds.length === 0) err('manifest.json', '有 hooks/ 但 permissions.hooks 是空的：没声明的钩子不会生效');
  const views = [];
  for (const e of await list('views')) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const where = `views/${e.name}`;
    let v;
    try {
      v = await readJson(`views/${e.name}`);
    } catch {
      err(where, '不是合法的 JSON');
      continue;
    }
    if (typeof v.title !== 'string' || !v.title.trim()) err(where, '缺少 title');
    if (v.placement !== undefined && !['sidebar', 'panel'].includes(v.placement)) err(where, 'placement 只能是 sidebar 或 panel');
    const entry = inside(v.entry);
    if (!entry || !/\.html?$/i.test(v.entry)) err(where, 'entry 要写插件文件夹里的 .html 相对路径');
    else if (!existsSync(entry)) err(where, `entry 指向的 ${v.entry} 不存在`);
    if (v.icon !== undefined && (!inside(v.icon) || !/\.svg$/i.test(v.icon) || !existsSync(inside(v.icon)))) err(where, 'icon 要指向插件文件夹里存在的 .svg');
    const tools = v.permissions?.tools;
    if (tools !== undefined && (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string' || t.includes('__')))) err(where, 'permissions.tools 写本插件工具的原名列表（不带前缀）');
    views.push({ where, tools: Array.isArray(tools) ? tools : undefined });
    if (entry && existsSync(entry)) {
      const html = await readFile(entry, 'utf8');
      if (/<(script|link)[^>]+(src|href)=["']https?:/i.test(html)) err(where, '页面不能从网上加载脚本或样式（沙箱只放本插件的文件），请把文件放进插件');
    }
  }
  if (m.mail && servers.filter((s) => s.kind === 'mcp').length === 0) err('manifest.json', '声明了 mail，但插件里没有 MCP server');

  // ---- secrets, and environment variables that will not be there ----
  const files = await packageFiles(root);
  const inherited = new Set(PLUGIN_INHERIT_ENV.map((k) => k.toUpperCase()));
  const declaredEnv = new Set(servers.flatMap((s) => Object.keys(s.env)));
  for (const rel of files) {
    if (/\.(png|jpe?g|gif|ico|exe|dll|node|zip|woff2?|ttf|pdf)$/i.test(rel) || statSync(join(root, rel)).size > 2_000_000) continue;
    const text = await readFile(join(root, rel), 'utf8');
    for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) err(rel, `里面有${what}。密钥不能进插件包：放进 SPICA_PLUGIN_DATA 里的配置文件，或做一个设置页让用户填（见 references/internal-services.md）`);
    if (!/\.(m?js|cjs|ts|py)$/i.test(rel) || /(^|\/)test\//.test(rel)) continue;
    for (const name of new Set([...text.matchAll(ENV_READS)].map((x) => x[1] ?? x[2] ?? x[3]))) {
      if (APP_SET_ENV.test(name) || inherited.has(name.toUpperCase()) || declaredEnv.has(name)) continue;
      if (SECRET_NAME.test(name)) warn(rel, `读环境变量 ${name}：装进 Spica 后读不到（只传白名单变量，带 KEY、TOKEN、SECRET 的一律不传）。凭据放 SPICA_PLUGIN_DATA 里的配置文件，或做设置页让用户填，见 references/internal-services.md`);
      else warn(rel, `读环境变量 ${name}：装进 Spica 后读不到（只传白名单变量：PATH、TEMP、用户目录、COMPUTERNAME、USERNAME 这类，全表见作者指南第 2 节）。要用就写进 mcp/<id>.json 的 env，或改读 SPICA_PLUGIN_DATA 里的配置文件`);
    }
  }
  if (files.some((f) => /(^|\/)\.env(\.|$)/.test(f))) err('.env', '.env 文件不能进插件包（放进 .spicaignore）');

  // ---- start servers in mock mode ----
  if (opts.start !== false && report.errors.length === 0) {
    const data = await mkdtemp(join(tmpdir(), 'spica-check-'));
    try {
      for (const s of servers) {
        const client = new StdioClient({
          command: s.runtime === 'node' ? process.execPath : s.entry,
          args: s.runtime === 'node' ? [s.entry, ...s.args] : s.args,
          cwd: root,
          env: pluginEnv({ ...s.env, SPICA_MOCK: '1', SPICA_PLUGIN_NAME: m.name, SPICA_PLUGIN_VERSION: m.version, SPICA_PLUGIN_DIR: root, SPICA_PLUGIN_DATA: join(data, s.id) }),
          timeoutMs: 15_000,
        });
        try {
          await client.initialize();
          const tools = await client.listTools();
          report.tools[s.launchName] = tools.map((t) => t.name);
          report.ok.push(`${s.kind}/${s.id}.json 在模拟模式下启动了，${tools.length} 个工具：${tools.map((t) => t.name).join('、') || '（没有）'}`);
          for (const t of tools) {
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(t.name ?? '')) err(`${s.kind}/${s.id}`, `工具名 ${t.name} 只能用字母、数字、_ 和 -`);
            if (!t.description?.trim()) err(`${s.kind}/${s.id}`, `工具 ${t.name} 没有 description（模型只看得到它）`);
            if (t.inputSchema?.type !== 'object') err(`${s.kind}/${s.id}`, `工具 ${t.name} 的 inputSchema 要是 { "type": "object", ... }`);
            if (t.annotations?.destructiveHint && !irreversible.includes(t.name)) warn(`${s.kind}/${s.id}`, `工具 ${t.name} 标了 destructiveHint，但没写进 permissions.irreversible`);
          }
        } catch (e) {
          err(`${s.kind}/${s.id}.json`, `模拟模式下起不来：${e.message}`);
        } finally {
          await client.close();
        }
      }
    } finally {
      await rm(data, { recursive: true, force: true }).catch(() => {});
    }
    const all = new Set(Object.values(report.tools).flat());
    if (servers.length > 0 && Object.keys(report.tools).length === servers.length) {
      for (const t of irreversible) if (!all.has(t)) err('manifest.json', `permissions.irreversible 里的 ${t} 不是任何 server 的工具`);
      if (m.mail) for (const t of [m.mail.list_tool, m.mail.read_tool]) if (!all.has(t)) err('manifest.json', `mail 里的 ${t} 不是 server 的工具`);
      for (const v of views) for (const t of v.tools ?? []) if (!all.has(t)) err(v.where, `permissions.tools 里的 ${t} 不是本插件的工具`);
    }
  }

  // ---- tests ----
  if (opts.tests !== false && existsSync(join(root, 'test'))) {
    const r = await runNodeTests(root);
    if (r.code === 0) report.ok.push('test/ 里的测试全过');
    else err('test/', `测试没过（退出码 ${r.code}）：\n${r.tail}`);
  }

  // ---- pack ----
  if (opts.pack !== false && report.errors.length === 0) {
    const entries = [];
    for (const rel of await packageFiles(root)) entries.push({ name: rel, data: await readFile(join(root, rel)) });
    const zip = writeZip(entries);
    const out = resolve(opts.out ?? join(root, 'dist'));
    await mkdir(out, { recursive: true });
    const file = join(out, `${m.name}-${m.version}.zip`);
    const sum = sha256(zip);
    await writeFile(file, zip);
    await writeFile(`${file}.sha256`, `${sum}  ${basename(file)}\n`);
    report.package = { file, sha256: sum, files: entries.length, bytes: zip.length };
    if (zip.length > 4 * 1024 * 1024) warn('包', `有 ${(zip.length / 1048576).toFixed(1)} MB；从别的电脑经 HTTP 装时，Spica 要能直接读到这个文件路径`);
  }
  report.name = m.name;
  report.version = m.version;
  return report;
}

function runNodeTests(cwd) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--test'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SPICA_MOCK: '1' } });
    const lines = [];
    const keep = (b) => {
      lines.push(...b.toString().split('\n'));
      if (lines.length > 60) lines.splice(0, lines.length - 60);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', (code) => resolveRun({ code, tail: lines.filter((l) => /not ok|Error|assert|expected|actual|fail/i.test(l)).slice(-20).join('\n') }));
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  if (!dir) {
    console.log('用法：node check.mjs <插件文件夹> [--out 输出文件夹] [--no-tests] [--no-start] [--no-pack]');
    process.exit(2);
  }
  const outAt = args.indexOf('--out');
  const report = await check(dir, {
    ...(outAt >= 0 ? { out: args[outAt + 1] } : {}),
    tests: !args.includes('--no-tests'),
    start: !args.includes('--no-start'),
    pack: !args.includes('--no-pack'),
  });
  for (const l of report.ok) console.log(`✓ ${l}`);
  for (const l of report.warnings) console.log(`！ ${l}`);
  for (const l of report.errors) console.log(`✗ ${l}`);
  if (report.package) console.log(`\n已打包：${report.package.file}\nSHA-256：${report.package.sha256}（${report.package.files} 个文件）`);
  console.log(report.errors.length ? `\n有 ${report.errors.length} 处要改。` : '\n可以装了。');
  process.exit(report.errors.length ? 1 : 0);
}
