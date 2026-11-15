import { describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../shared/updates';
import { CHECK_EVERY_MS, FIRST_CHECK_MS, IDLE_AFTER_S, idleInstallDue, pluginUpdateCount, scheduleChecks } from './schedule';

const ready: UpdateState = { status: 'ready', current: '0.2.0', available: '0.2.1', source: 'x', sourceFromDeploy: true, portable: false };

describe('scheduleChecks', () => {
  it('checks the app and the plugins together, soon after start and then every few hours; one failing does not stop the other', async () => {
    const timers: [string, number, () => void][] = [];
    const checkApp = vi.fn(() => Promise.reject(new Error('offline')));
    const checkPlugins = vi.fn(() => Promise.resolve());
    scheduleChecks({ checkApp, checkPlugins, setTimeout: (fn, ms) => timers.push(['once', ms, fn]), setInterval: (fn, ms) => timers.push(['every', ms, fn]) });
    expect(timers.map(([k, ms]) => [k, ms])).toEqual([
      ['once', FIRST_CHECK_MS],
      ['every', CHECK_EVERY_MS],
    ]);
    timers[0]![2]();
    timers[1]![2]();
    await Promise.resolve();
    expect(checkApp).toHaveBeenCalledTimes(2);
    expect(checkPlugins).toHaveBeenCalledTimes(2);
  });
});

describe('idleInstallDue', () => {
  const idle = IDLE_AFTER_S;
  it('with 自动更新 on: a downloaded update, nothing running, the computer left alone long enough', () => {
    expect(idleInstallDue({ update: ready, whenIdle: true, busy: false, idleSeconds: idle })).toBe(true);
    expect(idleInstallDue({ update: ready, whenIdle: true, busy: false, idleSeconds: idle - 1 })).toBe(false);
    expect(idleInstallDue({ update: ready, whenIdle: true, busy: true, idleSeconds: idle * 10 })).toBe(false);
    expect(idleInstallDue({ update: { ...ready, status: 'downloading' }, whenIdle: true, busy: false, idleSeconds: idle })).toBe(false);
  });

  it('off: never by itself, unless the version must update (still not while something runs)', () => {
    expect(idleInstallDue({ update: ready, whenIdle: false, busy: false, idleSeconds: idle * 10 })).toBe(false);
    expect(idleInstallDue({ update: { ...ready, required: true }, whenIdle: false, busy: false, idleSeconds: idle })).toBe(true);
    expect(idleInstallDue({ update: { ...ready, required: true }, whenIdle: false, busy: true, idleSeconds: idle })).toBe(false);
    expect(idleInstallDue({ update: { ...ready, status: 'manual', required: true }, whenIdle: true, busy: false, idleSeconds: idle })).toBe(false);
  });
});

describe('pluginUpdateCount', () => {
  it('counts the offered packages newer than the installed ones', () => {
    expect(pluginUpdateCount(undefined)).toBe(0);
    expect(pluginUpdateCount({})).toBe(0);
    expect(pluginUpdateCount({ available: [{ newer: true }, {}, { newer: true }, { newer: false }] })).toBe(2);
  });
});
