import { describe, expect, it, vi } from 'vitest';
import { autostartSupport, LOGIN_ARG, onSecondLaunch, startedAtLogin, syncAutostart, type LoginItems } from './autostart';

describe('who may use 开机时启动', () => {
  it('an installed copy on Windows only', () => {
    expect(autostartSupport({ platform: 'win32', packaged: true, portable: false })).toBe('ok');
    expect(autostartSupport({ platform: 'win32', packaged: false, portable: false })).toBe('dev');
    expect(autostartSupport({ platform: 'win32', packaged: true, portable: true })).toBe('portable');
    expect(autostartSupport({ platform: 'darwin', packaged: true, portable: false })).toBe('unsupported');
  });
});

describe('a run Windows started at sign-in', () => {
  it('is told by the registered argument', () => {
    expect(startedAtLogin(['C:\\Spica\\Spica.exe', LOGIN_ARG])).toBe(true);
    expect(startedAtLogin(['C:\\Spica\\Spica.exe'])).toBe(false);
    expect(startedAtLogin(['C:\\Spica\\Spica.exe', '--autostart-later'])).toBe(false);
  });

  it('a second start shows the running window, unless Windows started it', () => {
    const reveal = vi.fn();
    onSecondLaunch(['Spica.exe'], reveal);
    expect(reveal).toHaveBeenCalledTimes(1);
    onSecondLaunch(['Spica.exe', LOGIN_ARG], reveal);
    expect(reveal).toHaveBeenCalledTimes(1);
  });
});

function io(registered: boolean) {
  const sets: unknown[] = [];
  const items: LoginItems = {
    get: () => ({ openAtLogin: registered }),
    set: (item) => {
      sets.push(item);
      registered = item.openAtLogin;
    },
  };
  return { items, sets };
}

describe('the registration follows the switch', () => {
  const exe = 'C:\\Users\\a\\AppData\\Local\\Programs\\Spica\\Spica.exe';

  it('registers this exe with the sign-in argument, and removes it again', () => {
    const r = io(false);
    expect(syncAutostart({ support: 'ok', want: true, exe, io: r.items })).toBe('registered');
    expect(r.sets).toEqual([{ openAtLogin: true, path: exe, args: [LOGIN_ARG] }]);
    expect(syncAutostart({ support: 'ok', want: true, exe, io: r.items })).toBe('unchanged');
    expect(syncAutostart({ support: 'ok', want: false, exe, io: r.items })).toBe('removed');
    expect(r.sets).toHaveLength(2);
  });

  it('a development run or a portable copy never reads or writes the registration', () => {
    for (const support of ['dev', 'portable', 'unsupported'] as const) {
      const r = io(false);
      const get = vi.spyOn(r.items, 'get');
      expect(syncAutostart({ support, want: true, exe, io: r.items })).toBe('skipped');
      expect(get).not.toHaveBeenCalled();
      expect(r.sets).toEqual([]);
    }
  });

  it('a failing system call is reported, not thrown', () => {
    const items: LoginItems = {
      get: () => ({ openAtLogin: false }),
      set: () => {
        throw new Error('denied');
      },
    };
    expect(syncAutostart({ support: 'ok', want: true, exe, io: items })).toBe('failed');
  });
});
