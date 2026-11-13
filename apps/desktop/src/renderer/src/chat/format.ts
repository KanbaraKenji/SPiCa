// What the user sees for a tool call (a plain-language verb and its target),
// plus small formatting helpers shared by the conversation and the detail panel.
const LABELS: Record<string, string> = {
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '修改文件',
  list_dir: '查看文件夹',
  glob: '查找文件',
  grep: '搜索内容',
  run_command: '运行命令',
  web_fetch: '打开网页',
  web_search: '网页搜索',
  send_email: '发送邮件',
  ask_user: '提问',
  spawn_agent: '创建子任务',
  message_agent: '发消息给子任务',
  wait_agents: '等待子任务',
  record_decision: '记录决定',
  suggest_actions: '给出建议',
  create_project: '创建项目',
  list_projects: '查看项目',
  open_project: '打开项目',
  project_status: '查看项目进度',
  set_stage: '推进阶段',
  add_work_object: '添加工作对象',
  list_work_objects: '查看工作对象',
  // The assistant looking through earlier conversations.
  search_history: '查找对话记录',
  read_history: '读取对话记录',
  find_history_files: '查找对话中的文件',
  // The files a task made, handed over to the user (they show as cards under the answer).
  present_files: '交付文件',
  // The user's memory (shown as the 已记住 line in the conversation).
  remember: '保存记忆',
  forget: '删除记忆',
};

/** Tools that read other conversations: their results name them as ses_…#n, shown as links. */
export const HISTORY_TOOLS = new Set(['search_history', 'read_history', 'find_history_files']);

export function toolLabel(name: string): string {
  return LABELS[name] ?? name;
}

/** The one argument worth showing on a collapsed row (path, query, command, URL...). */
export function toolTarget(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const v = input as Record<string, unknown>;
  for (const key of ['path', 'pattern', 'query', 'command', 'url', 'to', 'subject', 'title', 'name', 'stage', 'decision', 'text', 'session_id']) {
    const value = v[key];
    if (typeof value === 'string' && value) return value === '.' ? '工作文件夹' : value.length > 60 ? `${value.slice(0, 60)}…` : value;
  }
  return '';
}

/** A moment as month/day hour:minute (a settings-change card, an item in 设置 › 记忆); '' when not a date. */
export function timeOf(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
 * When a message was written, from now (他: 「just now(刚刚)、9 minutes ago、5 hours ago」): just now under a
 * minute (and for a moment ahead of the clock), N minute(s) ago, N hour(s) ago under a day, yesterday and N days
 * ago by the calendar, after a week the date (Nov 5; with the year when it is not this year). '' when not a date.
 */
export function relativeTime(at: string, now: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const diff = now - d.getTime();
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return plural(Math.floor(diff / 60_000), 'minute');
  if (diff < 86_400_000) return plural(Math.floor(diff / 3_600_000), 'hour');
  const today = new Date(now);
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === today.getFullYear() ? date : `${date}, ${d.getFullYear()}`;
}

/** The full moment, for the hover over a relative time: 2026年11月12日 14:38. '' when not a date. */
export function fullTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
  if (/[一-鿿]/.test(reason) || reason.startsWith('「')) return reason;
  const target = toolTarget(input);
  return target ? `${toolLabel(name)}：${target}` : toolLabel(name);
}

/** Why the core asks for a confirmation it would not ask otherwise (outside content was involved). */
export const GUARD_CAUSE_TEXT: Record<string, string> = {
  untrusted_turn: '处理外部内容后的不可逆操作，需要确认。',
  outside_link: '链接来自外部内容，需要确认。',
  sensitive_file: '将读取密钥类文件，需要确认。',
};

/** Outside content that carried instructions; they were ignored, not followed. */
export const GUARD_FLAG_TEXT: Record<string, string> = {
  mail: '邮件中含有指令，已忽略',
  web: '网页中含有指令，已忽略',
  file: '文件中含有指令，已忽略',
  mcp: '插件返回内容中含有指令，已忽略',
};
