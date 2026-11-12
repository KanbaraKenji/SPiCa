import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHOTS_ACCOUNT, accountAtStart, accountFromProfile, autoAccount } from './user-account';

describe('the user account by the company rule', () => {
  it('is the user folder name in capitals', () => {
    expect(accountFromProfile('C:\\Users\\alex.chen')).toBe('ALEX.CHEN');
    expect(accountFromProfile('C:\\Users\\Alex.Chen\\')).toBe('ALEX.CHEN');
    expect(accountFromProfile('D:\\Profiles\\chen')).toBe('CHEN');
    expect(accountFromProfile('')).toBe('');
  });

  it('asks the system for the folder it is given, and never throws', () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    expect(autoAccount({ platform: 'win32', profileDir: () => 'C:\\Users\\alex.chen', log })).toBe('ALEX.CHEN');
    expect(lines).toEqual([]);
    expect(autoAccount({ platform: 'win32', profileDir: () => '', log })).toBe('');
    expect(
      autoAccount({
        platform: 'win32',
        profileDir: () => {
          throw new Error('no profile');
        },
        log,
      }),
    ).toBe('');
    expect(autoAccount({ platform: 'linux', profileDir: () => '/home/alex', log })).toBe('');
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toMatch(/no profile/);
  });

  it('screenshots show a made-up account; a development run can try another; a packaged copy always uses the rule', () => {
    const profileDir = () => 'C:\\Users\\alex.chen';
    const base = { platform: 'win32' as const, profileDir, log: () => undefined };
    expect(accountAtStart({ ...base, packaged: false, automated: true })).toBe(SHOTS_ACCOUNT);
    expect(SHOTS_ACCOUNT).toBe('ALEX.CHEN');
    expect(accountAtStart({ ...base, packaged: false, automated: false, env: { SPICA_DEV_ACCOUNT: 'very.long.name' } })).toBe('VERY.LONG.NAME');
    expect(accountAtStart({ ...base, packaged: false, automated: false, env: { SPICA_DEV_ACCOUNT: '-' } })).toBe('');
    expect(accountAtStart({ ...base, packaged: true, automated: false, env: { SPICA_DEV_ACCOUNT: 'other' } })).toBe('ALEX.CHEN');
    expect(accountAtStart({ ...base, packaged: false, automated: false, env: {} })).toBe('ALEX.CHEN');
  });

  // The rule itself on this machine: a real child process with USERPROFILE (and HOMEPATH, USERNAME) pointing
  // elsewhere still finds the same folder, while os.homedir() follows USERPROFILE.
  it.runIf(process.platform === 'win32')('a process started with another USERPROFILE gets the same account', () => {
    const expected = accountFromProfile(userInfo().homedir);
    expect(expected).not.toBe('');
    const script = "const os=require('os'),p=require('path');process.stdout.write(JSON.stringify({a:p.win32.basename(os.userInfo().homedir).toUpperCase(),h:os.homedir()}))";
    const out = JSON.parse(
      execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, USERPROFILE: 'C:\\Windows\\Temp\\someone.else', HOMEPATH: '\\Windows\\Temp\\someone.else', USERNAME: 'SOMEONE.ELSE' },
        encoding: 'utf8',
        windowsHide: true,
      }),
    ) as { a: string; h: string };
    expect(out.a).toBe(expected);
    expect(win32.basename(out.h)).toBe('someone.else');
  });
});
