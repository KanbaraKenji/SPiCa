import { describe, expect, it } from 'vitest';
import type { ScheduleInfo } from '@spica/protocol';
import { repeatText, scheduleLine, whenText } from './model';
import { formOf, inputOf } from './ScheduleViews';

const now = new Date(2026, 10, 22, 15, 0); // a Sunday, in this computer's time zone
const task = (over: Partial<ScheduleInfo>): ScheduleInfo => ({
  id: 'sch_1',
  title: '每日报表',
  prompt: 'p',
  trigger: { type: 'time', repeat: { kind: 'daily', time: '09:00' } },
  enabled: true,
  nextAt: new Date(2026, 10, 23, 9).toISOString(),
  failures: 0,
  createdBy: 'user',
  createdAt: '',
  updatedAt: '',
  ...over,
});

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

  it('says the next run while on; off, only how it repeats (the switch and the run mark say the rest)', () => {
    expect(scheduleLine(task({}), now)).toBe('每天 09:00 · 下次 明天 09:00');
    expect(scheduleLine(task({ enabled: false, nextAt: null, pausedAfterFailures: true, failures: 3 }), now)).toBe('每天 09:00');
    const once = new Date(2026, 10, 28, 10).toISOString();
    expect(scheduleLine(task({ trigger: { type: 'time', repeat: { kind: 'once', at: once } }, nextAt: once }), now)).toBe('一次 · 下次 周六 10:00');
  });
});

describe('the form', () => {
  it('reads back what it was given, and says which field is wrong', () => {
    const weekly = task({ trigger: { type: 'time', repeat: { kind: 'weekly', days: [5, 1], time: '17:30' } }, providerId: 'deepseek', model: 'deepseek-flash', cwd: 'D:/r' });
    const v = formOf(weekly, now);
    expect(v).toMatchObject({ kind: 'weekly', days: [5, 1], time: '17:30', model: 'deepseek/deepseek-flash', cwd: 'D:/r' });
    expect(inputOf(v)).toEqual({ input: { title: '每日报表', prompt: 'p', trigger: { type: 'time', repeat: { kind: 'weekly', days: [1, 5], time: '17:30' } }, cwd: 'D:/r', providerId: 'deepseek', model: 'deepseek-flash' } });
    expect(inputOf({ ...v, time: '9:5' })).toEqual({ problem: '时间不对' });
    expect(inputOf({ ...v, kind: 'daily', time: '9:05' })).toMatchObject({ input: { trigger: { repeat: { kind: 'daily', time: '09:05' } } } });
    expect(inputOf({ ...v, kind: 'interval', every: '2', unit: 'hours' })).toMatchObject({ input: { trigger: { repeat: { kind: 'interval', minutes: 120 } } } });
    expect(inputOf({ ...v, kind: 'once', date: '2026/2/30', time: '10:00' })).toEqual({ problem: '日期不对' });
    const once = inputOf({ ...v, kind: 'once', date: '2026/11/28', time: '10:00' });
    expect('input' in once && once.input.trigger.repeat).toEqual({ kind: 'once', at: new Date(2026, 10, 28, 10).toISOString() });
    expect(inputOf({ ...v, title: ' ' })).toEqual({ problem: '请填写名称' });
  });
});
