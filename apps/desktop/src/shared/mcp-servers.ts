// The MCP services the person adds in 设置 (not the ones plugins bring): what the settings page sees and sends. A
// service is a program on this computer (命令) or a server at a web address (网址, with a 密钥 and 更多请求头).
// Secrets (environment variables' values, the key, headers' values) only travel renderer -> main when typed; main
// sends back a mask.
import type { InstallPreview } from '@spica/protocol';
import { N_, t } from './i18n';
import { isLocalHost } from './local-host';

/** When one of its tools runs: asked each time (the default for a service the person added) or straight away. */
export type McpApproval = 'ask' | 'auto';

/**
 * How it is running: as a plugin's process (Plugins.tsx SERVER_STATUS); 'off' when its switch is off; for npx and
 * uvx, 'needs-download' (the package is not here: waits for the person) and 'downloading'.
 */
export type McpStatus = 'running' | 'starting' | 'restarting' | 'stopped' | 'failed' | 'off' | 'needs-download' | 'downloading';

/** An environment variable of a saved service: its name and its value masked. */
export interface McpEnvView {
  name: string;
  mask: string;
}

/** A program on this computer, or a server at a web address. */
export type McpKind = 'program' | 'url';

/** A saved service as the page sees it. */
export interface McpServerView {
  /** Its name, also the start of its tools' names (`<name>__<tool>`). */
  name: string;
  /** A server at a web address (then command and args are empty). */
  url?: string;
  /** With url: the key's mask, when one is saved. */
  key?: string;
  /** With url: the other request headers, values masked. */
  headers?: McpEnvView[];
  command: string;
  args: string[];
  env: McpEnvView[];
  cwd?: string;
  enabled: boolean;
  approval: McpApproval;
  status: McpStatus;
  /** The tools it offers (names as the service gives them), once it has started. */
  tools: string[];
  /** Why it stopped (the last error). */
  lastError?: string;
  /** The last lines it wrote to its error output. */
  logTail?: string[];
  /** 'needs-download': what would be downloaded, for the same list the app's Python download shows. */
  download?: InstallPreview;
  /** 'failed': why (McpProblem of @spica/plugins), worded by mcpProblemText. */
  problem?: McpProblemView;
}

/** Why a service is not running, as the backend reads it. */
export type McpProblemView =
  | { kind: 'not-found'; command: string }
  | { kind: 'exited'; code: number | null }
  | { kind: 'timeout'; seconds: number }
  | { kind: 'crash-loop'; count: number; seconds: number }
  | { kind: 'version'; versions: string[] }
  | { kind: 'unreachable'; status?: number }
  | { kind: 'needs-key' }
  | { kind: 'bad-key' }
  | { kind: 'certificate'; reason: 'untrusted' | 'expired' | 'name' }
  | { kind: 'other' };

/** Programs a missing command usually belongs to (said after it). */
const NEEDS: Record<string, string> = { npx: 'Node.js', node: 'Node.js', npm: 'Node.js', uvx: 'uv', uv: 'uv', python: 'Python', python3: 'Python', py: 'Python', docker: 'Docker' };

/** The reason in the interface language (the service's own words stay in its log). */
export function mcpProblemText(p: McpProblemView): string {
  switch (p.kind) {
    case 'not-found': {
      const base = p.command.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '');
      const program = NEEDS[base.toLowerCase()];
      return program ? t('找不到命令「{command}」（需要 {program}）', { command: base, program }) : t('找不到命令「{command}」', { command: base });
    }
    case 'exited':
      return p.code === null ? t('进程已退出') : t('进程已退出（代码 {code}）', { code: p.code });
    case 'timeout':
      return t('连接超时（{seconds} 秒内无响应）', { seconds: p.seconds });
    case 'crash-loop':
      return t('{seconds} 秒内崩溃 {count} 次，已停止重启', { seconds: p.seconds, count: p.count });
    case 'version':
      return t('版本不兼容（服务仅支持 {versions}）', { versions: p.versions.join(t('、')) });
    case 'unreachable':
      return p.status ? t('无法打开网址（HTTP {status}）', { status: p.status }) : t('无法打开网址');
    case 'needs-key':
      return t('需要密钥');
    case 'bad-key':
      return t('密钥无效');
    case 'certificate':
      return p.reason === 'expired' ? t('证书已过期') : p.reason === 'name' ? t('证书与网址不符') : t('证书不受信任');
    default:
      return t('启动失败');
  }
}

/** What the page asks of the main process (DesktopChannel.Mcp). */
export type McpCommand =
  | { op: 'list' }
  | { op: 'save'; was: string | null; draft: McpServerDraft }
  | { op: 'remove'; name: string }
  | { op: 'setEnabled'; name: string; on: boolean }
  | { op: 'setApproval'; name: string; approval: McpApproval }
  | { op: 'download'; name: string };

export interface McpListView {
  servers: McpServerView[];
  /** Names a new service cannot take (plugins' servers). */
  taken: string[];
}

/** The answer: the list as it is now, and for save what is wrong by field (empty: saved). */
export interface McpResult {
  list: McpListView;
  errors?: McpFieldErrors & { ''?: string };
}

/** A row of 环境变量 in the form: a saved one (value masked, empty keeps it) or a new one. */
export interface McpEnvDraft {
  name: string;
  value?: string;
  saved?: boolean;
}

export interface McpServerDraft {
  name: string;
  kind: McpKind;
  /** kind 'url': the address. */
  url: string;
  /** kind 'url': the key, sent as Authorization: Bearer (empty: none, or the saved one kept when keySaved). */
  key: string;
  /** A key is saved: empty keeps it (clearing it is keySaved false). */
  keySaved?: boolean;
  /** kind 'url': more request headers (values sealed as environment variables'). */
  headers: McpEnvDraft[];
  command: string;
  /** One argument a line (a line is one argument as it is: spaces and quotes stay in it). */
  args: string;
  env: McpEnvDraft[];
  cwd: string;
  approval: McpApproval;
}

export const emptyMcpDraft = (): McpServerDraft => ({ name: '', kind: 'program', url: '', key: '', headers: [], command: '', args: '', env: [], cwd: '', approval: 'ask' });

export function draftOf(s: McpServerView): McpServerDraft {
  return {
    name: s.name,
    kind: s.url ? 'url' : 'program',
    url: s.url ?? '',
    key: '',
    ...(s.key ? { keySaved: true } : {}),
    headers: (s.headers ?? []).map((h) => ({ name: h.name, saved: true })),
    command: s.command,
    args: s.args.join('\n'),
    env: s.env.map((e) => ({ name: e.name, saved: true })),
    cwd: s.cwd ?? '',
    approval: s.approval,
  };
}

/**
 * What is wrong with a web address: empty, not one, or plain http to a host that is not this computer or on the
 * local network (isLocalHost: localhost, loopback, private and link-local addresses; any other name needs https).
 */
export function mcpUrlError(text: string): string | undefined {
  const s = text.trim();
  if (!s) return t('必填');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return t('网址无效');
  }
  if (u.protocol === 'https:') return undefined;
  if (u.protocol === 'http:' && isLocalHost(u.hostname)) return undefined;
  return u.protocol === 'http:' ? t('只支持 https（本机和内网可用 http）') : t('网址无效');
}

/** The key as it is sent: what was typed, without a "Bearer " the person put before it. */
export function keyOf(text: string): string {
  return text.trim().replace(/^Bearer\s+/i, '');
}

/** The arguments of a draft: one a line, empty lines dropped, each as it is. */
export function draftArgs(d: Pick<McpServerDraft, 'args'>): string[] {
  return d.args.split(/\r?\n/).filter((a) => a.trim() !== '');
}

/** A service's name: letters, digits, _ and - (it becomes the start of its tools' names). */
export const MCP_NAME = /^[A-Za-z0-9_-]{1,40}$/;

export type McpFieldErrors = Partial<Record<'name' | 'command' | 'env' | 'url' | 'headers', string>>;

/** What is wrong with the draft, by field; `taken`: the names already in use (other services, plugins' servers). */
export function mcpDraftErrors(d: McpServerDraft, taken: readonly string[]): McpFieldErrors {
  const errors: McpFieldErrors = {};
  const name = d.name.trim();
  if (!name) errors.name = t('必填');
  else if (!MCP_NAME.test(name)) errors.name = t('只能用字母、数字、_ 和 -');
  else if (taken.some((n) => n.toLowerCase() === name.toLowerCase())) errors.name = t('名称已被使用');
  if (d.kind === 'url') {
    const url = mcpUrlError(d.url);
    if (url) errors.url = url;
    const seen = new Set<string>();
    for (const h of d.headers) {
      const n = h.name.trim();
      if (!n) continue;
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(n)) errors.headers ??= t('请求头名称「{name}」无效', { name: n });
      else if (seen.has(n.toLowerCase())) errors.headers ??= t('请求头「{name}」重复', { name: n });
      else if (n.toLowerCase() === 'authorization' && (keyOf(d.key) || d.keySaved)) errors.headers ??= t('「Authorization」与「密钥」重复');
      seen.add(n.toLowerCase());
    }
    return errors;
  }
  if (!d.command.trim()) errors.command = t('必填');
  const seen = new Set<string>();
  for (const e of d.env) {
    const n = e.name.trim();
    if (!n) continue;
    if (seen.has(n.toUpperCase())) errors.env = t('环境变量「{name}」重复', { name: n });
    seen.add(n.toUpperCase());
  }
  return errors;
}

/** One argument as a Windows command line would need it: in quotes when it has a space, a quote or is empty. */
export function quoteArg(a: string): string {
  if (a !== '' && !/[\s"]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** The whole command line, as it is shown before saving and on the service's page. */
export function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteArg).join(' ');
}

/** What a pasted `mcpServers` block filled: the services found (the first fills the form). */
export interface McpPasteResult {
  /** A program (command, args, env, cwd) or a web address (url, key, headers). */
  servers: { name: string; command: string; args: string[]; env: { name: string; value: string }[]; cwd?: string; url?: string; key?: string; headers?: { name: string; value: string }[] }[];
}

/**
 * Reads what another app's settings hold: `{"mcpServers": {...}}`, the inside of it, or one service
 * (`{"command": …}`); VS Code's `servers` too. Null when it is not JSON of that shape.
 */
export function parseMcpPaste(text: string): McpPasteResult | null {
  const body = text.trim().replace(/,\s*$/, '');
  // a whole object, or a bare `"name": {…}` as copied out of a longer file
  const data = parseJson(body.startsWith('{') ? body : `{${body}}`);
  if (!isObject(data)) return null;
  const map: Record<string, unknown> = isObject(data.mcpServers) ? data.mcpServers : isObject(data.servers) ? data.servers : typeof data.command === 'string' || typeof data.url === 'string' ? { '': data } : data;
  const out: McpPasteResult = { servers: [] };
  for (const [name, v] of Object.entries(map)) {
    if (!isObject(v)) continue;
    // a web address: url (Cursor, Claude, VS Code, Cline: also type sse), httpUrl (Gemini CLI), serverUrl (Windsurf)
    const url = [v.url, v.httpUrl, v.serverUrl].find((u): u is string => typeof u === 'string' && u.trim() !== '');
    if (url !== undefined && typeof v.command !== 'string') {
      const headers = isObject(v.headers) ? Object.entries(v.headers).filter((e): e is [string, string] => typeof e[1] === 'string') : [];
      // Authorization: Bearer … fills 密钥; the others go to 更多请求头
      const auth = headers.find(([n, value]) => n.toLowerCase() === 'authorization' && /^Bearer\s+\S/i.test(value));
      out.servers.push({
        name,
        command: '',
        args: [],
        env: [],
        url: url.trim(),
        ...(auth ? { key: keyOf(auth[1]) } : {}),
        headers: headers.filter((h) => h !== auth).map(([n, value]) => ({ name: n, value })),
      });
      continue;
    }
    if (typeof v.command !== 'string') continue;
    const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string') : [];
    const env = isObject(v.env) ? Object.entries(v.env).filter((e): e is [string, string] => typeof e[1] === 'string').map(([n, value]) => ({ name: n, value })) : [];
    out.servers.push({ name, command: v.command, args, env, ...(typeof v.cwd === 'string' ? { cwd: v.cwd } : {}) });
  }
  return out.servers.length ? out : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The status in words (as a plugin's process, plus 已停用). */
export const MCP_STATUS: Record<McpStatus, string> = {
  running: N_('运行中'),
  starting: N_('启动中'),
  restarting: N_('重启中'),
  stopped: N_('已停止'),
  failed: N_('错误'),
  off: N_('已停用'),
  'needs-download': N_('待下载'),
  downloading: N_('正在下载'),
};

/** Where npx and uvx download from, as the download list shows it. */
export const DOWNLOAD_HOSTS: Record<'npx' | 'uvx', string> = { npx: 'registry.npmjs.org', uvx: 'pypi.org' };

/** The download list for a service that waits for one (a package, perhaps uv's own Python; sizes not known before). */
export function downloadPreview(need: { runner: 'npx' | 'uvx'; package: string; python: boolean; version?: string; bytes?: number }): InstallPreview {
  // the name without the version written in it, the version the registry said beside it
  const name = need.version ? need.package.replace(/(.)@[^@/]*$/, '$1') : need.package;
  return {
    ...(need.python ? { python: { version: '', host: 'github.com' } } : {}),
    packages: [{ name: name || need.runner, ...(need.version ? { version: need.version } : {}), ...(need.bytes ? { bytes: need.bytes } : {}) }],
    packageHost: DOWNLOAD_HOSTS[need.runner],
  };
}
