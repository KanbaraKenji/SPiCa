// 定时任务: how a task's times are said, in this computer's time zone (the core keeps them; nothing here runs them).
import type { ScheduleInfo, ScheduleRepeat, ScheduleRun } from '@spica/protocol';
import { N_, t } from '../../../shared/i18n';
import { knownError } from '../../../shared/errors';

const WEEKDAYS = [N_('周日'), N_('周一'), N_('周二'), N_('周三'), N_('周四'), N_('周五'), N_('周六')];
export const WEEKDAY_SHORT = [N_('日'), N_('一'), N_('二'), N_('三'), N_('四'), N_('五'), N_('六')];
/** Monday first, as the form lists them. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const pad = (n: number) => String(n).padStart(2, '0');
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const shortDate = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;

/** 每天 09:00 · 每周一、三 17:30 · 每 2 小时 · 11/28 10:00 */
export function repeatText(r: ScheduleRepeat): string {
  if (r.kind === 'daily') return t('每天 {time}', { time: r.time });
  if (r.kind === 'weekly') {
    const days = WEEK_ORDER.filter((d) => r.days.includes(d)).map((d) => t(WEEKDAY_SHORT[d]!));
    return t('每周{days} {time}', { days: days.join(t('、')), time: r.time });
  }
  if (r.kind === 'interval') return r.minutes % 60 === 0 ? t('每 {n} 小时', { n: r.minutes / 60 }) : t('每 {n} 分钟', { n: r.minutes });
  const at = new Date(r.at);
  return `${shortDate(at)} ${hm(at)}`;
}

/** 今天 09:00 · 明天 09:00 · 周一 17:30 (within a week) · 11/28 10:00. */
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

/**
 * The line under a task's name: how it repeats, and its next run while on (每天 09:00 · 下次 明天 09:00). Off, only how
 * it repeats: the switch says it is off, the run mark says why (one place each).
 */
export function scheduleLine(s: ScheduleInfo, now: Date): string {
  const r = s.trigger.repeat;
  if (r.kind === 'once') return s.enabled ? t('一次 · 下次 {when}', { when: whenText(s.nextAt, now) }) : t('一次 · {when}', { when: whenText(r.at, now) });
  const when = repeatText(r);
  return s.enabled ? `${when} · ${t('下次 {when}', { when: whenText(s.nextAt, now) })}` : when;
}

export const RUN_WORDS: Record<ScheduleRun['status'], string> = {
  running: N_('运行中'),
  done: N_('已完成'),
  waiting: N_('等待确认'),
  failed: N_('失败'),
  skipped: N_('已跳过'),
};

/** Why a run did not finish, in words (the core's RunEndReason and its own). */
export function runReason(r: ScheduleRun): string {
  switch (r.reason) {
    case 'budget':
      return t('已达花费上限');
    case 'interrupted':
      return t('应用退出时中断');
    case 'aborted':
      return t('已中断');
    case 'repeated':
      return t('重复操作，已停止');
    case 'previous_waiting':
      return t('上次运行在等待确认');
    case 'max_turns':
      return t('达到轮数上限');
    default:
      // the core's words for a known error (余额不足, 模型不存在…), else plainly 运行出错; the whole text is on hover
      return (r.detail && knownError(r.detail)) || t('运行出错');
  }
}
