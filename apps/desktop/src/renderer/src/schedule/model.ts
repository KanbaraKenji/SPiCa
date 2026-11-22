// 定时任务 (mock-up): what a scheduled task is, how its time is said, and the demo list the screenshots show.
// Nothing here runs anything: the core has no scheduler yet. The trigger is a tagged union so a later
// event trigger (mail, a webhook, a file) adds a member instead of changing the time one.
import { N_, t } from '../../../shared/i18n';

export type Repeat =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'interval'; minutes: number }
  | { kind: 'once'; at: string };

/** What starts a run. Only `time` this round. */
export type Trigger = { type: 'time'; repeat: Repeat };

export type RunStatus = 'done' | 'failed' | 'waiting' | 'skipped' | 'running';

export interface ScheduleRun {
  id: string;
  at: string;
  status: RunStatus;
  /** The conversation the run is in. */
  sessionId?: string;
  /** Failed / skipped: why, one line. */
  reason?: string;
}

export interface ScheduleItem {
  id: string;
  title: string;
  prompt: string;
  trigger: Trigger;
  cwd: string;
  model: string;
  enabled: boolean;
  /** Each run in a new conversation, or back in the one it was set up in. */
  output: 'new' | 'same';
  /** output 'same': that conversation. */
  sessionId?: string;
  nextAt: string | null;
  /** Newest first. */
  runs: ScheduleRun[];
  /** Turned off after this many failures in a row. */
  pausedAfterFailures?: number;
}

export type ScheduleLayout = 'sidebar' | 'settings' | 'chat';
export type ScheduleScene = 'create' | 'list' | 'result' | 'waiting';

const WEEKDAYS = [N_('周日'), N_('周一'), N_('周二'), N_('周三'), N_('周四'), N_('周五'), N_('周六')];
export const WEEKDAY_SHORT = [N_('日'), N_('一'), N_('二'), N_('三'), N_('四'), N_('五'), N_('六')];
/** Monday first, as the form lists them. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const pad = (n: number) => String(n).padStart(2, '0');
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** 每天 09:00 · 每周一、三 17:30 · 每 2 小时 · 11/28 10:00 */
export function repeatText(r: Repeat): string {
  if (r.kind === 'daily') return t('每天 {time}', { time: r.time });
  if (r.kind === 'weekly') {
    const days = WEEK_ORDER.filter((d) => r.days.includes(d)).map((d) => t(WEEKDAY_SHORT[d]!));
    return t('每周{days} {time}', { days: days.join(t('、')), time: r.time });
  }
  if (r.kind === 'interval') return r.minutes % 60 === 0 ? t('每 {n} 小时', { n: r.minutes / 60 }) : t('每 {n} 分钟', { n: r.minutes });
  return t('{date} {time}', { date: shortDate(new Date(r.at)), time: hm(new Date(r.at)) });
}

function shortDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 今天 09:00 · 明天 09:00 · 周一 17:30 (within a week) · 11/28 10:00; in this computer's time zone. */
export function whenText(iso: string | null | undefined, now: Date): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const days = Math.round((dayStart(d) - dayStart(now)) / 86_400_000);
  if (days === 0) return t('今天 {time}', { time: hm(d) });
  if (days === 1) return t('明天 {time}', { time: hm(d) });
  if (days === -1) return t('昨天 {time}', { time: hm(d) });
  if (days > 1 && days < 7) return `${t(WEEKDAYS[d.getDay()]!)} ${hm(d)}`;
  return `${shortDate(d)} ${hm(d)}`;
}

export const RUN_WORDS: Record<RunStatus, string> = {
  done: N_('已完成'),
  failed: N_('失败'),
  waiting: N_('等待确认'),
  skipped: N_('已跳过'),
  running: N_('运行中'),
};
