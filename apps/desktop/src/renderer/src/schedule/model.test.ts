import { describe, expect, it } from 'vitest';
import { repeatText, whenText } from './model';
import { scheduleLine } from './ScheduleViews';
import { demoSchedules } from './demo';

const now = new Date(2026, 10, 22, 15, 0); // a Sunday, in this computer's time zone

describe('定时任务 times', () => {
  it('says how a task repeats', () => {
    expect(repeatText({ kind: 'daily', time: '09:00' })).toBe('每天 09:00');
    expect(repeatText({ kind: 'weekly', days: [3, 1], time: '17:30' })).toBe('每周一、三 17:30');
    expect(repeatText({ kind: 'interval', minutes: 120 })).toBe('每 2 小时');
    expect(repeatText({ kind: 'interval', minutes: 45 })).toBe('每 45 分钟');
    expect(repeatText({ kind: 'once', at: new Date(2026, 10, 28, 10, 0).toISOString() })).toBe('11/28 10:00');
  });

  it('says when, near now in words and further off as a date', () => {
    const at = (d: number, h: number) => new Date(2026, 10, 22 + d, h, 0).toISOString();
    expect(whenText(at(0, 9), now)).toBe('今天 09:00');
    expect(whenText(at(1, 9), now)).toBe('明天 09:00');
    expect(whenText(at(-1, 9), now)).toBe('昨天 09:00');
    expect(whenText(at(5, 17), now)).toBe('周五 17:00');
    expect(whenText(at(8, 10), now)).toBe('11/30 10:00');
    expect(whenText(null, now)).toBe('—');
  });

  it('says a one-off task’s time once in its row, and a paused one why', () => {
    const items = demoSchedules(now, { report: 'a', orders: 'b', sameChat: 'c', sameWaiting: 'd' });
    expect(scheduleLine(items.find((s) => s.id === 'sch-sample')!, now)).toBe('一次 · 下次 周六 10:00');
    expect(scheduleLine(items.find((s) => s.id === 'sch-backup')!, now)).toBe('每天 18:00 · 连续 3 次失败，已暂停');
  });
});
