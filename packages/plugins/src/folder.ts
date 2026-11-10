// Read a plugin folder: manifest plus the standard parts (skills, mcp, commands)
// and the extension parts (hooks, services, views). Nothing is started here.
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MANIFEST_FILE, appNameOf, parseManifest, stripBom, type Issue, type MessageOptions, type PluginManifest } from './manifest.ts';

export interface SkillDef {
  /** Folder name under skills/. */
  id: string;
  name: string;
  description: string;
  /** Instructions (Markdown body after the frontmatter). */
  body: string;
  file: string;
}

export interface CommandDef {
  /** File name without .md; the user types /<id>. */
  id: string;
  description: string;
  argumentHint?: string;
  /** Prompt template; $ARGUMENTS and $1..$9 are replaced. */
  template: string;
  file: string;
}

export interface ServerDef {
  /** File name without .json under mcp/ or services/. */
  id: string;
  kind: 'mcp' | 'service';
  /** node: run `entry` with the host's Node. binary: `entry` is a bundled executable. */
  runtime: 'node' | 'binary';
  /** Absolute path, checked to stay inside the plugin folder. */
  entry: string;
  args: string[];
  env: Record<string, string>;
  description?: string;
  timeoutMs?: number;
  restart: { maxRestarts: number; windowMs: number };
  /** Give the server's tools to the model. Default: true for mcp/, false for services/. */
  exposeTools: boolean;
}

export interface HookModuleDef {
  /** File name, e.g. "inject-hint.js". */
  id: string;
  file: string;
}

export const VIEW_PLACEMENTS = ['sidebar', 'panel'] as const;

export interface ViewDef {
  /** File name without .json, e.g. "notebook". */
  id: string;
  title: string;
  /** Where the shell shows it: a sidebar entry of its own, or a panel beside the conversation. */
  placement: (typeof VIEW_PLACEMENTS)[number];
  /** HTML entry, relative to the plugin folder (forward slashes). */
  entry: string;
  /** SVG icon, relative to the plugin folder. */
  icon?: string;
  /** Tools of this plugin the page may call (names as the server lists them); undefined = all of them. */
  tools?: string[];
}

export interface PluginFolder {
  root: string;
  manifest?: PluginManifest;
  skills: SkillDef[];
  commands: CommandDef[];
  servers: ServerDef[];
  hooks: HookModuleDef[];
  views: ViewDef[];
  issues: Issue[];
}

export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/**
 * Resolve a path written in a plugin file. It must be relative and stay inside
 * the plugin folder; returns undefined otherwise.
 */
export function insidePlugin(root: string, rel: string): string | undefined {
  if (!rel || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith('\\\\')) return undefined;
  const abs = resolve(root, rel);
  const r = relative(resolve(root), abs);
  if (r === '' || r.startsWith('..') || isAbsolute(r) || r.split(sep).includes('..')) return undefined;
  return abs;
}

/** Tiny frontmatter parser: `key: value` lines between `---` fences. */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const t = stripBom(text).replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(t);
  if (!m) return { data: {}, body: t.trim() };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    data[kv[1]!] = v;
  }
  return { data, body: m[2]!.trim() };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function list(dir: string): Promise<{ name: string; isDir: boolean }[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export async function readPluginFolder(root: string, opts: MessageOptions = {}): Promise<PluginFolder> {
  const out: PluginFolder = { root: resolve(root), skills: [], commands: [], servers: [], hooks: [], views: [], issues: [] };
  const issue = (where: string, message: string, severity: Issue['severity'] = 'error') => out.issues.push({ where, message, severity });

  const manifestPath = join(root, MANIFEST_FILE);
  if (!(await exists(manifestPath))) {
    issue(MANIFEST_FILE, `缺少 ${MANIFEST_FILE}，不是插件文件夹（${out.root}）。`);
    return out;
  }
  const parsed = parseManifest(await readFile(manifestPath, 'utf8'), MANIFEST_FILE, opts);
  out.issues.push(...parsed.issues);
  if (parsed.manifest) out.manifest = parsed.manifest;

  // skills/<id>/SKILL.md
  for (const e of await list(join(root, 'skills'))) {
    if (!e.isDir) continue;
    const where = `skills/${e.name}/SKILL.md`;
    const file = join(root, 'skills', e.name, 'SKILL.md');
    if (!(await exists(file))) {
      issue(where, `技能文件夹「${e.name}」里没有 SKILL.md。`);
      continue;
    }
    const { data, body } = parseFrontmatter(await readFile(file, 'utf8'));
    if (!ID.test(e.name)) issue(where, `技能文件夹名「${e.name}」只能用小写字母、数字、- 和 _。`);
    if (!data.description) issue(where, '技能缺少 description，请在开头 --- 之间写 description: …。');
    if (!body) issue(where, '技能正文为空。');
    out.skills.push({ id: e.name, name: data.name || e.name, description: data.description ?? '', body, file });
  }

  // commands/<id>.md
  for (const e of await list(join(root, 'commands'))) {
    if (e.isDir || !e.name.endsWith('.md')) continue;
    const id = e.name.slice(0, -3);
    const where = `commands/${e.name}`;
    const file = join(root, 'commands', e.name);
    const { data, body } = parseFrontmatter(await readFile(file, 'utf8'));
    if (!ID.test(id)) issue(where, `命令名「${id}」只能用小写字母、数字、- 和 _。`);
    if (!body) issue(where, '命令正文为空。');
    out.commands.push({
      id,
      description: data.description ?? '',
      ...(data['argument-hint'] ? { argumentHint: data['argument-hint'] } : {}),
      template: body,
      file,
    });
  }

  // mcp/<id>.json and services/<id>.json
  for (const kind of ['mcp', 'service'] as const) {
    const dirName = kind === 'mcp' ? 'mcp' : 'services';
    for (const e of await list(join(root, dirName))) {
      if (e.isDir || !e.name.endsWith('.json')) continue;
      const id = e.name.slice(0, -5);
      const where = `${dirName}/${e.name}`;
      const def = parseServer(out.root, id, kind, await readFile(join(root, dirName, e.name), 'utf8'), where, issue, appNameOf(opts));
      if (def) {
        if (!(await exists(def.entry))) issue(where, `找不到入口文件 ${relative(out.root, def.entry)}。`);
        out.servers.push(def);
      }
    }
  }
  const ids = out.servers.map((s) => s.id);
  for (const id of new Set(ids)) {
    if (ids.filter((x) => x === id).length > 1) issue(`mcp/${id}.json`, `mcp/ 与 services/ 中的「${id}」重名，请改名。`);
  }

  // hooks/*.js | *.mjs
  for (const e of await list(join(root, 'hooks'))) {
    if (e.isDir) continue;
    if (/\.(m?js)$/.test(e.name)) out.hooks.push({ id: e.name, file: join(root, 'hooks', e.name) });
    else if (/\.(m?ts|cjs)$/.test(e.name)) {
      issue(`hooks/${e.name}`, '钩子须为 ESM 的 .js 或 .mjs 文件（TypeScript 请先编译为 .js）。', 'warning');
    }
  }

  // views/<id>.json: pages the shell renders in a sandbox
  for (const e of await list(join(root, 'views'))) {
    if (e.isDir || !e.name.endsWith('.json')) continue;
    const id = e.name.slice(0, -5);
    const where = `views/${e.name}`;
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(stripBom(await readFile(join(root, 'views', e.name), 'utf8'))) as Record<string, unknown>;
    } catch {
      issue(where, '视图声明不是有效的 JSON。');
      continue;
    }
    const before = out.issues.length;
    const relFile = async (field: string, value: unknown, ext: RegExp, example: string): Promise<string | undefined> => {
      if (value === undefined) return undefined;
      const abs = typeof value === 'string' ? insidePlugin(out.root, value) : undefined;
      if (!abs) issue(where, `${field} 须为插件文件夹内的相对路径，不能用 .. 或绝对路径，例如 "${example}"。`);
      else if (!ext.test(value as string)) issue(where, `${field} 须指向 ${example.slice(example.lastIndexOf('.'))} 文件。`);
      else if (!(await exists(abs))) issue(where, `${field} 指向的 ${value as string} 不存在。`);
      else return relative(out.root, abs).split(sep).join('/');
      return undefined;
    };
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) issue(where, '视图文件名只能用小写字母、数字和 -，例如 views/notebook.json。');
    if (typeof v.title !== 'string' || !v.title.trim()) issue(where, '视图缺少 title。');
    const placement = v.placement ?? 'sidebar';
    if (!(VIEW_PLACEMENTS as readonly unknown[]).includes(placement)) issue(where, `视图的 placement 只能是 ${VIEW_PLACEMENTS.join(' 或 ')}。`);
    if (v.entry === undefined) issue(where, '视图缺少 entry，例如 "ui/index.html"。');
    const entry = await relFile('entry', v.entry, /\.html?$/i, 'ui/index.html');
    const icon = await relFile('icon', v.icon, /\.svg$/i, 'ui/icon.svg');
    let tools: string[] | undefined;
    const perm = v.permissions as { tools?: unknown } | undefined;
    if (perm !== undefined) {
      if (typeof perm !== 'object' || perm === null || Array.isArray(perm)) issue(where, 'permissions 须为 { "tools": ["工具名", ...] }。');
      else if (perm.tools !== undefined) {
        if (!Array.isArray(perm.tools) || perm.tools.some((t) => typeof t !== 'string' || !t || t.includes('__'))) {
          issue(where, 'permissions.tools 须为本插件工具的原名列表（不带插件前缀），例如 ["list_notes"]。');
        } else tools = [...new Set(perm.tools as string[])];
      }
    }
    if (out.issues.length === before && entry) {
      out.views.push({ id, title: (v.title as string).trim(), placement: placement as ViewDef['placement'], entry, ...(icon ? { icon } : {}), ...(tools ? { tools } : {}) });
    }
  }

  // A mail declaration must point at one MCP server.
  const mail = out.manifest?.mail;
  if (mail) {
    const mcp = out.servers.filter((s) => s.kind === 'mcp');
    if (mail.server && !mcp.some((s) => s.id === mail.server)) issue('manifest.json · mail.server', `mcp/ 中没有「${mail.server}」。`);
    else if (!mail.server && mcp.length !== 1) {
      issue('manifest.json · mail', mcp.length === 0 ? '声明了邮件来源，但插件里没有 MCP server。' : '插件有多个 MCP server，请在 mail.server 中指定。');
    }
  }

  // Irreversible tools must at least be plausible names.
  if (out.manifest && out.servers.length === 0 && out.manifest.permissions.irreversible.length > 0) {
    issue('manifest.json · permissions.irreversible', '声明了不可逆工具，但插件里没有 MCP server。', 'warning');
  }
  // Hook kinds declared but no hook modules (or the reverse) is worth a warning.
  if (out.manifest && out.hooks.length > 0 && out.manifest.permissions.hooks.length === 0) {
    issue('manifest.json · permissions.hooks', 'permissions.hooks 未声明钩子类型，钩子不会生效，例如 ["inject"]。');
  }
  return out;
}

function parseServer(
  root: string,
  id: string,
  kind: 'mcp' | 'service',
  text: string,
  where: string,
  issue: (where: string, message: string, severity?: Issue['severity']) => void,
  app: string,
): ServerDef | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stripBom(text)) as Record<string, unknown>;
  } catch {
    issue(where, '声明不是有效的 JSON。');
    return undefined;
  }
  let ok = true;
  const bad = (m: string) => {
    issue(where, m);
    ok = false;
  };
  if (!ID.test(id)) bad(`名字「${id}」只能用小写字母、数字、- 和 _。`);
  const runtime = raw.runtime;
  if (runtime !== 'node' && runtime !== 'binary') {
    bad(
      runtime === 'python'
        ? 'Python server 须打包为可执行文件：runtime 设为 "binary"，entry 指向 .exe。'
        : `「runtime」只能是 "node"（由 ${app} 自带的 Node 运行 .js）或 "binary"（插件自带的可执行文件）。`,
    );
  }
  const entryRel = raw.entry;
  const entry = typeof entryRel === 'string' ? insidePlugin(root, entryRel) : undefined;
  if (!entry) bad('「entry」须为插件文件夹内的相对路径，不能用绝对路径或 ..。');
  else if (runtime === 'node' && !/\.(m?js|cjs)$/.test(entry)) bad('Node server 的 entry 须为 .js / .mjs / .cjs 文件。');
  else if (runtime === 'binary' && /\.(cmd|bat|ps1|vbs)$/i.test(entry)) {
    bad('入口不能是脚本（.cmd / .bat / .ps1），请打包为 .exe。');
  }
  const args = raw.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) bad('「args」须为文字列表。');
  const env = raw.env ?? {};
  if (typeof env !== 'object' || env === null || Array.isArray(env) || Object.values(env).some((v) => typeof v !== 'string')) {
    bad('「env」须为 { "名字": "值" } 形式的对象，值为文字。');
  } else if (Object.keys(env).some((k) => k.startsWith('SPICA_'))) bad('「env」中不能设置 SPICA_ 开头的变量。');
  const restart = (raw.restart ?? {}) as Record<string, unknown>;
  const maxRestarts = typeof restart.max_restarts === 'number' ? restart.max_restarts : 3;
  const windowSeconds = typeof restart.window_seconds === 'number' ? restart.window_seconds : 60;
  if (maxRestarts < 0 || maxRestarts > 10) bad('「restart.max_restarts」须在 0 到 10 之间。');
  if (!ok) return undefined;
  return {
    id,
    kind,
    runtime: runtime as ServerDef['runtime'],
    entry: entry!,
    args: args as string[],
    env: env as Record<string, string>,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(typeof raw.timeout_seconds === 'number' ? { timeoutMs: raw.timeout_seconds * 1000 } : {}),
    restart: { maxRestarts, windowMs: windowSeconds * 1000 },
    exposeTools: typeof raw.expose_tools === 'boolean' ? raw.expose_tools : kind === 'mcp',
  };
}

/** Fill a command template with the user's arguments. */
export function expandCommand(cmd: CommandDef, args: string): string {
  const words = args.trim() ? args.trim().split(/\s+/) : [];
  return cmd.template
    .replace(/\$ARGUMENTS/g, args.trim())
    .replace(/\$([1-9])/g, (_, n: string) => words[Number(n) - 1] ?? '');
}
