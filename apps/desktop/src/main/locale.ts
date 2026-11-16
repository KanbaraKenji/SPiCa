// The interface's language in the main process: what 语言 says, or Windows' languages for 跟随系统. Menus, the tray,
// dialogs and the core's locale follow it (shared/i18n).
import { app } from 'electron';

/**
 * Windows' languages, most preferred first. SPICA_SYSTEM_LOCALE stands in for them (tests and screenshots: the
 * system's language setting is never changed to see 跟随系统 work).
 */
export function systemLanguages(env: NodeJS.ProcessEnv = process.env): string[] {
  const forced = env.SPICA_SYSTEM_LOCALE?.trim();
  if (forced) return [forced];
  try {
    const list = app.getPreferredSystemLanguages();
    return list.length ? list : [app.getLocale()];
  } catch {
    return [app.getLocale()];
  }
}
