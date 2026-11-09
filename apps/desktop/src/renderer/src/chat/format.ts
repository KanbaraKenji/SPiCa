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
  ask_user: '向你提问',
};

export function toolLabel(name: string): string {
  return LABELS[name] ?? name;
}

/** The one argument worth showing on a collapsed row (path, query, command, URL...). */
export function toolTarget(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const v = input as Record<string, unknown>;
  for (const key of ['path', 'pattern', 'query', 'command', 'url', 'to', 'subject']) {
    const value = v[key];
    if (typeof value === 'string' && value) return value === '.' ? '工作文件夹' : value;
  }
  return '';
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return '不到 1 秒';
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
