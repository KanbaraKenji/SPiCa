import { describe, expect, it, vi } from 'vitest';
import { autostartSupport, followAutostart, LOGIN_ARG, loginItemOn, onSecondLaunch, registeredAtLogin, startedAtLogin, startsOnNewChat, syncAutostart, type LoginItems } from './autostart';

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

  it('opens on 新对话: every start (his rule), or only a start by Windows at sign-in', () => {
    expect(startsOnNewChat(['Spica.exe'])).toBe(true);
    expect(startsOnNewChat(['Spica.exe', LOGIN_ARG])).toBe(true);
    expect(startsOnNewChat(['Spica.exe'], 'login')).toBe(false);
    expect(startsOnNewChat(['Spica.exe', LOGIN_ARG], 'login')).toBe(true);
  });

  it('a second start shows the running window, unless Windows started it', () => {
    const reveal = vi.fn();
    onSecondLaunch(['Spica.exe'], reveal);
    expect(reveal).toHaveBeenCalledTimes(1);
    onSecondLaunch(['Spica.exe', LOGIN_ARG], reveal);
    expect(reveal).toHaveBeenCalledTimes(1);
  });
});

describe('what counts as registered', () => {
  it('the exact command line, or the entry under the app id with the sign-in argument (as the installer writes it)', () => {
    expect(loginItemOn({ openAtLogin: true }, 'dev.spica.desktop')).toBe(true);
    expect(loginItemOn({ openAtLogin: false, launchItems: [{ name: 'dev.spica.desktop', args: [LOGIN_ARG], scope: 'user' }] }, 'dev.spica.desktop')).toBe(true);
    expect(loginItemOn({ openAtLogin: false, launchItems: [{ name: 'Dev.Spica.Desktop', args: [LOGIN_ARG] }] }, 'dev.spica.desktop')).toBe(true);
    expect(loginItemOn({ openAtLogin: false, launchItems: [{ name: 'dev.spica.desktop', args: [] }] }, 'dev.spica.desktop')).toBe(false);
    expect(loginItemOn({ openAtLogin: false, launchItems: [{ name: 'other.app', args: [LOGIN_ARG] }] }, 'dev.spica.desktop')).toBe(false);
    expect(loginItemOn({ openAtLogin: false, launchItems: [{ name: 'dev.spica.desktop', args: [LOGIN_ARG], scope: 'machine' }] }, 'dev.spica.desktop')).toBe(false);
    expect(loginItemOn({ openAtLogin: false }, 'dev.spica.desktop')).toBe(false);
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

  it('at start the switch takes what Windows has; later changes are written once', () => {
    const r = io(true); // registered by something else (the installer)
    const log = vi.fn();
    const f = followAutostart({ support: 'ok', exe, io: r.items, log });
    expect(f.start(false)).toBe(true);
    expect(r.sets).toEqual([]);
    f.changed(true); // the setting store echoing the value it was given
    expect(r.sets).toEqual([]);
    f.changed(false);
    expect(r.sets).toEqual([{ openAtLogin: false, path: exe, args: [LOGIN_ARG] }]);
    f.changed(false);
    expect(r.sets).toHaveLength(1);
    expect(registeredAtLogin({ support: 'ok', exe, io: r.items })).toBe(false);
  });

  it('where it is not offered, the saved value stays and nothing is read or written', () => {
    const r = io(true);
    const get = vi.spyOn(r.items, 'get');
    const f = followAutostart({ support: 'dev', exe, io: r.items, log: () => undefined });
    expect(f.start(false)).toBe(false);
    f.changed(true);
    expect(get).not.toHaveBeenCalled();
    expect(r.sets).toEqual([]);
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
