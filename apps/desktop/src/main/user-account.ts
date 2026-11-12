// The user's account (工号) for plugins: worked out once here, at start, and
// handed to the core's process (BackendConfig extension options), which gives
// it to every plugin as SPICA_USER_ACCOUNT and ctx.user.account. The settings
// (常规 › 账号) may replace it; shared/settings.ts effectiveAccount.
//
// The company's rule (2026-11-12): the name of the Windows user folder, in
// capitals: C:\Users\alex.chen → ALEX.CHEN. The folder is asked of the system
// (os.userInfo().homedir: the profile folder of the user this process runs
// as), never read from USERPROFILE / HOMEPATH / USERNAME (os.homedir() reads
// USERPROFILE first) and never the sign-in name. In this process: no
// PowerShell or Python started for it.
import { userInfo } from 'node:os';
import { win32 } from 'node:path';

/** The account the screenshots show (a made-up one: committed pictures never carry a real name). */
export const SHOTS_ACCOUNT = 'ALEX.CHEN';

/** C:\Users\alex.chen → ALEX.CHEN; '' for a path with no folder name. */
export function accountFromProfile(profileDir: string): string {
  return win32.basename(profileDir.trim()).toUpperCase();
}

export interface AccountLookup {
  platform?: NodeJS.Platform;
  /** The user's profile folder, as the system has it. Default os.userInfo().homedir (tests pass their own). */
  profileDir?: () => string;
  log?: (line: string) => void;
}

/**
 * The account by the company's rule, or '' (with a line in the log) when it cannot be had: not Windows, the
 * system gives no folder, or asking throws. Never throws: the app starts without an account.
 */
export function autoAccount(o: AccountLookup = {}): string {
  const log = o.log ?? ((line: string) => console.warn(line));
  if ((o.platform ?? process.platform) !== 'win32') {
    log('[spica] user account: not Windows, plugins get none');
    return '';
  }
  try {
    const account = accountFromProfile((o.profileDir ?? (() => userInfo().homedir))());
    if (!account) log('[spica] user account: the system gave no user folder, plugins get none');
    return account;
  } catch (err) {
    log(`[spica] user account: could not ask for the user folder (${err instanceof Error ? err.message : String(err)}), plugins get none`);
    return '';
  }
}

/**
 * The automatic account of this start. Screenshots (SPICA_SHOTS / SPICA_CAPTURE) show SHOTS_ACCOUNT; a
 * development run can try another with SPICA_DEV_ACCOUNT (`-` for none); a packaged copy always uses the rule.
 */
export function accountAtStart(o: AccountLookup & { packaged: boolean; automated: boolean; env?: NodeJS.ProcessEnv }): string {
  if (o.automated) return SHOTS_ACCOUNT;
  const dev = o.packaged ? undefined : o.env?.SPICA_DEV_ACCOUNT;
  if (dev) return dev.trim() === '-' ? '' : dev.trim().toUpperCase();
  return autoAccount(o);
}
