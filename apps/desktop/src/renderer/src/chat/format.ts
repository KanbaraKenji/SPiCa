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
  message_agent: '给子任务发消息',
  wait_agents: '等子任务完成',
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

export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1 秒';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}

/** Timer text for the status line: 0:07, 1:24, 1:02:03. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
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
  if (/[一-鿿]/.test(reason)) return reason;
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
