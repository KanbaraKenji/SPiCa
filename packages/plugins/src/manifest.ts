// Plugin manifest (`manifest.json` at the plugin root): types and validation.
// The shape follows the MCPB manifest where the two overlap (name, version,
// author, license, compatibility) and adds Spica's permission and mock fields.
// Validation never throws: it returns issues with a plain-language message
// (Chinese, shown to the user as-is) and the JSON path that is wrong.

export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_VERSION = 1;
/** Name shown to users in messages; a branded build passes its own (only text changes, never identifiers). */
export const DEFAULT_APP_NAME = 'Spica';

/** Options for functions that produce messages meant for the user. */
export interface MessageOptions {
  /** App name in user-facing messages. Default DEFAULT_APP_NAME. */
  appName?: string;
}

export function appNameOf(opts?: MessageOptions): string {
  return opts?.appName?.trim() || DEFAULT_APP_NAME;
}

export type HookKind = 'inject' | 'beforeRequest' | 'afterResponse' | 'beforeTool' | 'afterTool';
export const HOOK_KINDS: readonly HookKind[] = ['inject', 'beforeRequest', 'afterResponse', 'beforeTool', 'afterTool'];

export interface PluginPermissions {
  /** Hosts the plugin's processes may reach. Empty = none declared (informational for now). */
  network: string[];
  /** Access to the session's working folder (the project folder). */
  workspace: 'none' | 'read' | 'write';
  /** Tool names (as the server reports them) that need user confirmation by default. */
  irreversible: string[];
  /** Hook kinds the plugin's hook modules may register. Anything else is refused. */
  hooks: HookKind[];
  /**
   * Use the models the user has set up (MCP sampling). Shown at install and
   * enable; the plugin needs no key of its own and spends at most maxUsdPerDay.
   */
  model?: { reason: string; maxUsdPerDay: number };
}

/** Daily limit for a plugin using the user's models when the manifest gives none (same as the core's default). */
export const DEFAULT_MODEL_USD_PER_DAY = 0.5;

export interface PluginManifest {
  manifestVersion: number;
  /** Short id: lowercase letters, digits and '-', 2–24 characters. Also the tool-name prefix. */
  name: string;
  version: string;
  displayName: string;
  description: string;
  author: { name: string; email?: string; url?: string };
  license: string;
  /** Compatible Spica versions, e.g. ">=0.1.0 <1.0.0" or "^0.1.0". */
  spica: string;
  permissions: PluginPermissions;
  mock: { supported: boolean; description?: string };
  /** The plugin is a mail source: which of its MCP tools list and read messages. */
  mail?: MailDeclaration;
  homepage?: string;
}

export interface MailDeclaration {
  /** MCP server id (file name under mcp/); may be left out when the plugin has one server. */
  server?: string;
  /** Tool names as the server reports them (without the plugin prefix). */
  listTool: string;
  readTool: string;
  /** Arguments for the list call. Default (core): { unread_only: true, limit: 50 }. */
  listArgs?: Record<string, unknown>;
  /** Field names in the list result, when they differ from the core's defaults. */
  fields?: { list?: string; id?: string; fromName?: string; fromAddress?: string; subject?: string; received?: string; preview?: string };
}

export interface Issue {
  /** Where the problem is: file plus JSON path, e.g. "manifest.json · version". */
  where: string;
  message: string;
  severity: 'error' | 'warning';
}

export const NAME_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Drop a leading byte-order mark (Notepad adds one). */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function isSemver(v: string): boolean {
  return SEMVER.test(v);
}

/** Compare two semver strings: -1, 0 or 1. Invalid versions sort first. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === rb) return 0;
  if (ra === undefined) return 1; // release > prerelease
  if (rb === undefined) return -1;
  const xa = ra.split('.');
  const xb = rb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const sa = xa[i];
    const sb = xb[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    const na = /^\d+$/.test(sa) ? Number(sa) : NaN;
    const nb = /^\d+$/.test(sb) ? Number(sb) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}

/**
 * Does `version` satisfy `range`? Supports space-separated comparators
 * (>=, >, <=, <, =), caret (^1.2.3) and tilde (~1.2.3), and `*`.
 */
export function satisfies(version: string, range: string): boolean {
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((p) => {
    if (p === '*') return true;
    const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(p);
    if (!m) return false;
    const op = m[1] ?? '=';
    const target = normalize(m[2]!);
    if (!target) return false;
    const c = compareVersions(version, target);
    switch (op) {
      case '>=':
        return c >= 0;
      case '>':
        return c > 0;
      case '<=':
        return c <= 0;
      case '<':
        return c < 0;
      case '=':
        return c === 0;
      case '^': {
        const [maj, min] = target.split('.').map(Number) as [number, number];
        const upper = maj > 0 ? `${maj + 1}.0.0` : `0.${min + 1}.0`;
        return c >= 0 && compareVersions(version, upper) < 0;
      }
      case '~': {
        const [maj, min] = target.split('.').map(Number) as [number, number];
        return c >= 0 && compareVersions(version, `${maj}.${min + 1}.0`) < 0;
      }
    }
    return false;
  });
}

/** "1" → "1.0.0", "1.2" → "1.2.0"; returns undefined for garbage. */
function normalize(v: string): string | undefined {
  const bits = v.split('-')[0]!.split('.');
  while (bits.length < 3) bits.push('0');
  const out = bits.join('.') + (v.includes('-') ? v.slice(v.indexOf('-')) : '');
  return isSemver(out) ? out : undefined;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parse the text of manifest.json. Returns the manifest when there are no errors. */
export function parseManifest(text: string, where = MANIFEST_FILE, opts: MessageOptions = {}): { manifest?: PluginManifest; issues: Issue[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { issues: [{ where, severity: 'error', message: `清单不是有效的 JSON（${detail}），请检查逗号和引号。` }] };
  }
  return validateManifest(raw, where, opts);
}

export function validateManifest(raw: unknown, where = MANIFEST_FILE, opts: MessageOptions = {}): { manifest?: PluginManifest; issues: Issue[] } {
  const app = appNameOf(opts);
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ where: `${where} · ${path}`, severity: 'error', message });
  const warn = (path: string, message: string) => issues.push({ where: `${where} · ${path}`, severity: 'warning', message });
  if (!isObj(raw)) {
    err('(根)', '清单顶层须为对象 { … }。');
    return { issues };
  }
  const str = (key: string, required: boolean): string | undefined => {
    const v = raw[key];
    if (v === undefined || v === '') {
      if (required) err(key, `缺少「${key}」。`);
      return undefined;
    }
    if (typeof v !== 'string') {
      err(key, `「${key}」须为文字，当前为 ${typeof v}。`);
      return undefined;
    }
    return v;
  };

  const mv = raw.manifest_version;
  if (mv === undefined) err('manifest_version', `缺少「manifest_version」，当前只支持 ${MANIFEST_VERSION}。`);
  else if (mv !== MANIFEST_VERSION) err('manifest_version', `清单版本 ${JSON.stringify(mv)} 无效，${app} 当前只支持 ${MANIFEST_VERSION}。`);

  const name = str('name', true);
  if (name !== undefined && !NAME_PATTERN.test(name)) {
    err('name', `插件名「${name}」无效：只能用小写字母、数字和 -，以字母开头，2 到 24 个字符（用作工具名前缀）。`);
  }
  const version = str('version', true);
  if (version !== undefined && !isSemver(version)) err('version', `版本号「${version}」无效，须为三段数字，例如 1.2.3。`);
  const description = str('description', true);
  const displayName = str('display_name', false);
  const license = str('license', false);
  if (license === undefined) warn('license', '缺少 license，例如 "Apache-2.0"。');
  const homepage = str('homepage', false);

  let author: PluginManifest['author'] | undefined;
  if (typeof raw.author === 'string' && raw.author) author = { name: raw.author };
  else if (isObj(raw.author) && typeof raw.author.name === 'string' && raw.author.name) {
    author = { name: raw.author.name };
    if (typeof raw.author.email === 'string') author.email = raw.author.email;
    if (typeof raw.author.url === 'string') author.url = raw.author.url;
  } else err('author', '缺少 author，例如 { "name": "…" }。');

  let spica = '*';
  const compat = raw.compatibility;
  if (compat !== undefined) {
    if (!isObj(compat)) err('compatibility', '「compatibility」须为对象，例如 { "spica": ">=0.1.0" }。');
    else if (compat.spica !== undefined) {
      if (typeof compat.spica !== 'string' || !satisfiesParse(compat.spica)) {
        err('compatibility.spica', `兼容范围 ${JSON.stringify(compat.spica)} 无效，例如 ">=0.1.0" 或 "^0.1.0"。`);
      } else spica = compat.spica;
    }
  } else warn('compatibility', '未声明 compatibility.spica，视为兼容所有版本。');

  const permissions: PluginPermissions = { network: [], workspace: 'none', irreversible: [], hooks: [] };
  const p = raw.permissions;
  if (p !== undefined && !isObj(p)) err('permissions', '「permissions」须为对象。');
  if (isObj(p)) {
    const list = (key: string): string[] => {
      const v = p[key];
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        err(`permissions.${key}`, `「permissions.${key}」须为文字列表，例如 ["a", "b"]。`);
        return [];
      }
      return v as string[];
    };
    permissions.network = list('network');
    permissions.irreversible = list('irreversible');
    const hooks = list('hooks');
    for (const h of hooks) {
      if (!(HOOK_KINDS as readonly string[]).includes(h)) err('permissions.hooks', `未知钩子「${h}」，可选：${HOOK_KINDS.join('、')}。`);
    }
    permissions.hooks = hooks.filter((h): h is HookKind => (HOOK_KINDS as readonly string[]).includes(h));
    const model = p.model;
    if (model !== undefined) {
      if (!isObj(model)) err('permissions.model', '「permissions.model」须为对象，例如 { "reason": "给笔记写摘要", "max_usd_per_day": 0.2 }。');
      else {
        const reason = typeof model.reason === 'string' ? model.reason.trim() : '';
        if (!reason) err('permissions.model.reason', '缺少 permissions.model.reason，例如 "给笔记写摘要"。');
        else if (reason.length > 200) err('permissions.model.reason', 'reason 不能超过 200 字。');
        let max = DEFAULT_MODEL_USD_PER_DAY;
        const m = model.max_usd_per_day;
        if (m !== undefined) {
          if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) err('permissions.model.max_usd_per_day', 'max_usd_per_day 须为大于 0 的数（美元），例如 0.2。');
          else {
            max = m;
            if (m > 5) warn('permissions.model.max_usd_per_day', `每日上限 ${m} 美元偏高，请确认。`);
          }
        }
        for (const k of Object.keys(model)) if (k !== 'reason' && k !== 'max_usd_per_day') warn(`permissions.model.${k}`, `未知字段「${k}」，已忽略。`);
        if (reason && reason.length <= 200) permissions.model = { reason, maxUsdPerDay: max };
      }
    }
    const ws = p.workspace;
    if (ws !== undefined) {
      if (ws === 'none' || ws === 'read' || ws === 'write') permissions.workspace = ws;
      else err('permissions.workspace', `「permissions.workspace」只能是 "none"、"read" 或 "write"，当前为 ${JSON.stringify(ws)}。`);
    }
  }

  const mock: PluginManifest['mock'] = { supported: false };
  if (raw.mock !== undefined) {
    if (!isObj(raw.mock) || typeof raw.mock.supported !== 'boolean') {
      err('mock', '「mock」须为 { "supported": true, "description": "…" }。');
    } else {
      mock.supported = raw.mock.supported;
      if (typeof raw.mock.description === 'string') mock.description = raw.mock.description;
    }
  }

  let mail: MailDeclaration | undefined;
  if (raw.mail !== undefined) {
    const m = raw.mail;
    const tool = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(v);
    if (!isObj(m) || !tool(m.list_tool) || !tool(m.read_tool)) {
      err('mail', '「mail」须为 { "list_tool": "列邮件的工具名", "read_tool": "读一封邮件的工具名" }，工具名为 server 中的原名（不带插件前缀）。');
    } else {
      mail = { listTool: m.list_tool as string, readTool: m.read_tool as string };
      if (m.server !== undefined) {
        if (typeof m.server === 'string' && m.server) mail.server = m.server;
        else err('mail.server', '「mail.server」须为 mcp/ 下的文件名（不带 .json）。');
      }
      if (m.list_args !== undefined) {
        if (isObj(m.list_args)) mail.listArgs = m.list_args;
        else err('mail.list_args', '「mail.list_args」须为对象，例如 { "unread_only": true }。');
      }
      if (m.fields !== undefined) {
        const keys: Record<string, keyof NonNullable<MailDeclaration['fields']>> = {
          list: 'list',
          id: 'id',
          from_name: 'fromName',
          from_address: 'fromAddress',
          subject: 'subject',
          received: 'received',
          preview: 'preview',
        };
        if (!isObj(m.fields) || Object.entries(m.fields).some(([k, v]) => !(k in keys) || typeof v !== 'string')) {
          err('mail.fields', `「mail.fields」只能包含这些键：${Object.keys(keys).join('、')}，值为列表结果中的字段名。`);
        } else mail.fields = Object.fromEntries(Object.entries(m.fields).map(([k, v]) => [keys[k], v as string]));
      }
    }
  }

  if (issues.some((i) => i.severity === 'error')) return { issues };
  const manifest: PluginManifest = {
    manifestVersion: MANIFEST_VERSION,
    name: name!,
    version: version!,
    displayName: displayName ?? name!,
    description: description!,
    author: author!,
    license: license ?? 'UNLICENSED',
    spica,
    permissions,
    mock,
    ...(mail ? { mail } : {}),
    ...(homepage ? { homepage } : {}),
  };
  return { manifest, issues };
}

function satisfiesParse(range: string): boolean {
  // A range is valid if every comparator parses; test against a dummy version.
  if (range.trim() === '') return false;
  return range
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .every((p) => p === '*' || (/^(>=|<=|>|<|=|\^|~)?(.+)$/.test(p) && normalize(p.replace(/^(>=|<=|>|<|=|\^|~)/, '')) !== undefined));
}
