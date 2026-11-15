// One timetable for both kinds of update: the app's (UpdateService) and the installed plugins' (their sources),
// checked together soon after start and then every few hours. A downloaded app update installs itself only
// when the computer has been left alone for a while and no conversation is running: with 设置 › 关于 ›
// 空闲时更新 on, or always when the source marks this version as one that must update.
import type { UpdateState } from '../../shared/updates';

/** The first check after start. */
export const FIRST_CHECK_MS = 10_000;
/** Then every this long. */
export const CHECK_EVERY_MS = 4 * 60 * 60_000;
/** No keyboard or mouse input on the computer for this long counts as idle (Electron's system idle time). */
export const IDLE_AFTER_S = 10 * 60;
/** How often idleness is looked at while an update waits. */
export const IDLE_POLL_MS = 60_000;

export interface ScheduleOptions {
  checkApp(): Promise<unknown>;
  checkPlugins(): Promise<unknown>;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  setInterval?: (fn: () => void, ms: number) => unknown;
}

/** Starts the timetable; each check runs on its own (one failing does not stop the other). */
export function scheduleChecks(o: ScheduleOptions): void {
  const later = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const every = o.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const both = () => {
    void o.checkApp().catch(() => undefined);
    void o.checkPlugins().catch(() => undefined);
  };
  later(both, FIRST_CHECK_MS);
  every(both, CHECK_EVERY_MS);
}

export interface IdleInstallInput {
  update: UpdateState;
  /** 设置 › 关于 › 空闲时更新. */
  whenIdle: boolean;
  /** A conversation is running (or waits on a confirmation or an answer). */
  busy: boolean;
  /** Seconds since the last keyboard or mouse input on the computer. */
  idleSeconds: number;
}

/** Whether the downloaded update should install itself now. */
export function idleInstallDue(i: IdleInstallInput): boolean {
  if (i.update.status !== 'ready') return false;
  if (!i.whenIdle && !i.update.required) return false;
  if (i.busy) return false;
  return i.idleSeconds >= IDLE_AFTER_S;
}

/** How many installed plugins the last read of their sources found a newer version for. */
export function pluginUpdateCount(state: { available?: readonly { newer?: boolean }[] } | undefined): number {
  return state?.available?.filter((a) => a.newer).length ?? 0;
}
