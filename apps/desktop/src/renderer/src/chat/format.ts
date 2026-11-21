// What the user sees for a tool call (a plain-language verb and its target),
// plus small formatting helpers shared by the conversation and the detail panel.
import { intlLocale, N_, t, tx } from '../../../shared/i18n';
import type { InstallFailure } from '@spica/protocol';
const LABELS: Record<string, string> = {
  read_file: N_('读取文件'),
  write_file: N_('写入文件'),
  edit_file: N_('修改文件'),
  list_dir: N_('查看文件夹'),
  glob: N_('查找文件'),
  grep: N_('搜索内容'),
  run_command: N_('运行命令'),
  python_env: N_('配置 Python'),
  run_javascript: N_('运行 JavaScript'),
  command_output: N_('查看后台命令'),
  stop_command: N_('停止后台命令'),
  get_diagnostics: N_('检查代码错误'),
  web_fetch: N_('打开网页'),
  web_search: N_('网页搜索'),
  browser_open: N_('在内置浏览器打开网页'),
  browser_read: N_('读取网页'),
  browser_screenshot: N_('网页截图'),
  browser_scroll: N_('滚动网页'),
  browser_wait: N_('等待网页'),
  browser_tabs: N_('查看浏览器标签'),
  browser_click: N_('点击网页'),
  browser_type: N_('在网页中输入'),
  browser_press: N_('在网页中按键'),
  browser_find: N_('查找网页元素'),
  browser_select: N_('在网页中选择'),
  browser_hover: N_('悬停网页元素'),
  browser_drag: N_('拖动网页元素'),
  browser_file_upload: N_('上传文件'),
  browser_javascript: N_('运行网页脚本'),
  browser_console: N_('读取网页控制台'),
  browser_network: N_('查看网页请求'),
  browser_batch: N_('批量操作网页'),
  send_email: N_('发送邮件'),
  ask_user: N_('提问'),
  spawn_agent: N_('创建子任务'),
  message_agent: N_('发消息给子任务'),
  wait_agents: N_('等待子任务'),
  record_decision: N_('记录决定'),
  suggest_actions: N_('给出建议'),
  create_project: N_('创建项目'),
  list_projects: N_('查看项目'),
  open_project: N_('打开项目'),
  project_status: N_('查看项目进度'),
  set_stage: N_('推进阶段'),
  add_work_object: N_('添加工作对象'),
  list_work_objects: N_('查看工作对象'),
  // The assistant looking through earlier conversations.
  search_history: N_('查找对话记录'),
  read_history: N_('读取对话记录'),
  find_history_files: N_('查找对话中的文件'),
  // The folders allowed on a card (始终允许), listed or taken back when the user asks.
  allowed_folders: N_('已允许的文件夹'),
  // The files a task made, handed over to the user (they show as cards under the answer).
  present_files: N_('交付文件'),
  // The user's memory (shown as the 已记住 line in the conversation).
  remember: N_('保存记忆'),
  forget: N_('删除记忆'),
};

/** Tools that read other conversations: their results name them as ses_…#n, shown as links. */
export const HISTORY_TOOLS = new Set(['search_history', 'read_history', 'find_history_files']);

export function toolLabel(name: string): string {
  const label = LABELS[name];
  return label ? t(label) : name;
}

/** The one argument worth showing on a collapsed row (path, query, command, URL...). */
export function toolTarget(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const v = input as Record<string, unknown>;
  for (const key of ['path', 'pattern', 'query', 'command', 'url', 'to', 'subject', 'title', 'name', 'stage', 'decision', 'text', 'session_id']) {
    const value = v[key];
    if (typeof value === 'string' && value) return value === '.' ? t('工作文件夹') : value.length > 60 ? `${value.slice(0, 60)}…` : value;
  }
  return '';
}

/** A moment as month/day hour:minute (a settings-change card, an item in 设置 › 记忆); '' when not a date. */
export function timeOf(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(intlLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * How long something took, once it is over: written as the ticking clock is (formatClock: 7s, 2m 5s, 1h 2m),
 * under a second <1s (他选「也改，全部统一」).
 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? '<1s' : formatClock(ms);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * When a message was written, from now, starting with a capital: Just now under a
 * minute (and for a moment ahead of the clock), N minute(s) ago, N hour(s) ago under a day, Yesterday and N days
 * ago by the calendar, after a week the date (Nov 5; with the year when it is not this year). '' when not a date.
 */
export function relativeTime(at: string, now: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const diff = now - d.getTime();
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return plural(Math.floor(diff / 60_000), 'minute');
  if (diff < 86_400_000) return plural(Math.floor(diff / 3_600_000), 'hour');
  const today = new Date(now);
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days <= 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === today.getFullYear() ? date : `${date}, ${d.getFullYear()}`;
}

/** The full moment, for the hover over a relative time: 2026年11月12日 14:38. '' when not a date. */
export function fullTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return t('{y}年{m}月{d}日 {time}', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), time });
}

/**
 * A run's ticking clock (the status line under the answer, the end of the Running … line): 7s, 2m 5s, 2m 0s,
 * 1h 2m (他: 「要用Xs 和Xm Xs这样的」). Minutes always say their seconds, so the text does not lose a part as
 * it ticks; from an hour on, no seconds.
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function parts(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean);
}

export function fileName(path: string): string {
  const p = parts(path);
  return p[p.length - 1] ?? path;
}

export function fileFolder(path: string): string {
  return parts(path).slice(0, -1).join('\\');
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** What a confirmation is about, in the user's words: the backend's reason when it is already plain Chinese, else verb + target. */
export function confirmTitle(name: string, input: unknown, reason: string): string {
  // A reason in Chinese, or one that starts with a plugin's name in 「」 (a plugin's declared irreversible tool).
  if (/[一-鿿]/.test(reason) || reason.startsWith('「')) return tx(reason); // i18n-skip: reads the reason (shown as the catalog has it, else as written)
  const target = toolTarget(input);
  return target ? t('{tool}：{target}', { tool: toolLabel(name), target }) : toolLabel(name);
}

/** Why the core asks for a confirmation it would not ask otherwise (outside content was involved). */
export const GUARD_CAUSE_TEXT: Record<string, string> = {
  // getters: the words in the language when they are shown
  get untrusted_turn() {
    return t('处理外部内容后的不可逆操作，需要确认。');
  },
  get outside_link() {
    return t('链接来自外部内容，需要确认。');
  },
  get sensitive_file() {
    return t('将读取密钥类文件，需要确认。');
  },
};

/** Outside content that carried instructions; they were ignored, not followed. */
export const GUARD_FLAG_TEXT: Record<string, string> = {
  // getters: the words in the language when they are shown
  get mail() {
    return t('邮件中含有指令，已忽略');
  },
  get web() {
    return t('网页中含有指令，已忽略');
  },
  get file() {
    return t('文件中含有指令，已忽略');
  },
  get mcp() {
    return t('插件返回内容中含有指令，已忽略');
  },
};

/** A file size: 512 B, 37 KB, 1.4 MB, 2.1 GB (powers of 1024). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} GB`;
}

/**
 * A failed python_env download as one short line (the core says the same to the Agent: python-tool.ts
 * INSTALL_FAILURE_WORDS; a test keeps them equal). Without a host, the generic line.
 */
const INSTALL_FAILURE: Record<InstallFailure['reason'], string> = {
  connect: N_('无法连接 {host}'),
  certificate: N_('{host} 的证书不受信任'),
  proxy: N_('无法连接代理'),
  proxy_auth: N_('代理需要身份验证（HTTP 407）'),
  disk: N_('磁盘空间不足'),
  other: N_('下载失败'),
};

export function installFailureText(f: InstallFailure): string {
  const key = f.host || !INSTALL_FAILURE[f.reason].includes('{host}') ? f.reason : 'other';
  return t(INSTALL_FAILURE[key], { host: f.host ?? '' });
}

/** Failures the network settings can do something about (proxy, certificates): their line has a 网络 button. */
export const NETWORK_FAILURES: ReadonlySet<InstallFailure['reason']> = new Set(['connect', 'certificate', 'proxy', 'proxy_auth']);
