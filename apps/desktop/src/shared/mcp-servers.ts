// The MCP services the person adds in 设置 (not the ones plugins bring): what the settings page sees and sends.
// Secrets (the values of environment variables) only travel renderer -> main when typed; main sends back a mask.
import type { InstallPreview } from '@spica/protocol';
import { N_, t } from './i18n';

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

/** A saved service as the page sees it. */
export interface McpServerView {
  /** Its name, also the start of its tools' names (`<name>__<tool>`). */
  name: string;
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
  command: string;
  /** One argument a line (a line is one argument as it is: spaces and quotes stay in it). */
  args: string;
  env: McpEnvDraft[];
  cwd: string;
  approval: McpApproval;
}

export const emptyMcpDraft = (): McpServerDraft => ({ name: '', command: '', args: '', env: [], cwd: '', approval: 'ask' });

export function draftOf(s: McpServerView): McpServerDraft {
  return { name: s.name, command: s.command, args: s.args.join('\n'), env: s.env.map((e) => ({ name: e.name, saved: true })), cwd: s.cwd ?? '', approval: s.approval };
}

/** The arguments of a draft: one a line, empty lines dropped, each as it is. */
export function draftArgs(d: Pick<McpServerDraft, 'args'>): string[] {
  return d.args.split(/\r?\n/).filter((a) => a.trim() !== '');
}

/** A service's name: letters, digits, _ and - (it becomes the start of its tools' names). */
export const MCP_NAME = /^[A-Za-z0-9_-]{1,40}$/;

export type McpFieldErrors = Partial<Record<'name' | 'command' | 'env', string>>;

/** What is wrong with the draft, by field; `taken`: the names already in use (other services, plugins' servers). */
export function mcpDraftErrors(d: McpServerDraft, taken: readonly string[]): McpFieldErrors {
  const errors: McpFieldErrors = {};
  const name = d.name.trim();
  if (!name) errors.name = t('必填');
  else if (!MCP_NAME.test(name)) errors.name = t('只能用字母、数字、_ 和 -');
  else if (taken.some((n) => n.toLowerCase() === name.toLowerCase())) errors.name = t('名称已被使用');
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

/** What a pasted `mcpServers` block filled: the services found (the first fills the form), and what was skipped. */
export interface McpPasteResult {
  servers: { name: string; command: string; args: string[]; env: { name: string; value: string }[]; cwd?: string }[];
  /** Entries that are not a local program (a url), by name. */
  skipped: string[];
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
  const out: McpPasteResult = { servers: [], skipped: [] };
  for (const [name, v] of Object.entries(map)) {
    if (!isObject(v)) continue;
    if (typeof v.command !== 'string') {
      if (typeof v.url === 'string' || typeof v.httpUrl === 'string') out.skipped.push(name);
      continue;
    }
    const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string') : [];
    const env = isObject(v.env) ? Object.entries(v.env).filter((e): e is [string, string] => typeof e[1] === 'string').map(([n, value]) => ({ name: n, value })) : [];
    out.servers.push({ name, command: v.command, args, env, ...(typeof v.cwd === 'string' ? { cwd: v.cwd } : {}) });
  }
  return out.servers.length || out.skipped.length ? out : null;
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
export function downloadPreview(need: { runner: 'npx' | 'uvx'; package: string; python: boolean }): InstallPreview {
  return {
    ...(need.python ? { python: { version: '', host: 'github.com' } } : {}),
    packages: [{ name: need.package || need.runner }],
    packageHost: DOWNLOAD_HOSTS[need.runner],
  };
}
