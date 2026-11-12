// 监控台: what the back end is doing, as lines the page lists (kept in the main process, main/monitor.ts).

/** Where a line comes from. */
export type MonitorSource = 'core' | 'request' | 'tool' | 'plugin' | 'process';
export type MonitorLevel = 'info' | 'warn' | 'error';

export const MONITOR_SOURCES: readonly [MonitorSource, string][] = [
  ['core', '内核'],
  ['request', '请求'],
  ['tool', '工具'],
  ['plugin', '插件'],
  ['process', '进程'],
];

export const MONITOR_LEVELS: readonly [MonitorLevel, string][] = [
  ['info', '信息'],
  ['warn', '警告'],
  ['error', '错误'],
];

export interface MonitorEntry {
  /** Increasing; the page asks for what came after the last one it has. */
  seq: number;
  /** ISO time. */
  at: string;
  source: MonitorSource;
  level: MonitorLevel;
  /** Plain text, secrets already removed. Never rendered as HTML or Markdown. */
  text: string;
  /** The conversation it belongs to, when there is one. */
  sessionId?: string;
}

/** One line as copied or exported: time, source, level, text. */
export function monitorLine(e: MonitorEntry): string {
  const src = MONITOR_SOURCES.find(([s]) => s === e.source)?.[1] ?? e.source;
  const lvl = MONITOR_LEVELS.find(([l]) => l === e.level)?.[1] ?? e.level;
  return `${e.at}\t${src}\t${lvl}\t${e.text}`;
}
