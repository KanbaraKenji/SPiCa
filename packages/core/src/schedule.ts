// Scheduled tasks: a prompt the core sends by itself at set times, in a new conversation each time or back in the
// conversation it was set up in.
//
// The clock is one timer that looks at the table every minute (and once soon after start, and when the shell says the
// computer woke up). Nothing is registered with the system: closed, the app runs nothing. A run due while the app was
// closed or the computer slept runs once when it is back (only the latest one, however many were missed); a run due
// while the previous one still waits for the user is skipped. Runs are started the way the mail pipeline starts its
// own: createSession + send with author 'runtime'. A run that meets a confirmation stops there, as any conversation
// does, and waits for the user. Failing SCHEDULE_FAILURES_TO_PAUSE times in a row turns the task off.
import { nextRun, SCHEDULE_FAILURES_TO_PAUSE, scheduleProblem, type RunEndReason, type ScheduleInfo, type ScheduleInput, type ScheduleRun } from '@spica/protocol';

export { nextRun, scheduleProblem } from '@spica/protocol';
import type { CoreEvent } from './events.ts';
import { isoNow } from './events.ts';
import type { Runtime } from './runtime.ts';
import { newId } from './util.ts';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * Why a task's folder cannot be worked in, or null: it must be a whole path to a folder that is there, with no control
 * characters (a \r an agent's string turned into a line break). The message starts with its code (folder_missing,
 * folder_invalid) for the window to say in its own words.
 */
export function folderProblem(cwd: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(cwd)) return 'folder_invalid: the folder has control characters in it (a line break, a tab)';
  if (!isAbsolute(cwd)) return `folder_invalid: the folder must be a whole path (${cwd})`;
  try {
    if (statSync(cwd).isDirectory()) return null;
  } catch {
    // not there
  }
  return `folder_missing: the folder does not exist (${cwd})`;
}

/** How often the table is looked at. */
export const SCHEDULE_TICK_MS = 60_000;
/** The first look after start (the window and the plugins come up first). */
const FIRST_TICK_MS = 5_000;
/** Started this much after it was due: it was missed (app closed, computer asleep) and runs late. */
const LATE_MS = 2 * 60_000;

/** How a run's conversation ended, as the task's run: done, waiting for the user, or failed. */
function outcome(reason: RunEndReason): ScheduleRun['status'] {
  if (reason === 'completed' || reason === 'max_turns') return 'done';
  if (reason === 'awaiting_confirm' || reason === 'awaiting_answer') return 'waiting';
  return 'failed';
}

export class Scheduler {
  readonly #rt: Runtime;
  readonly #now: () => Date;
  #timer: ReturnType<typeof setInterval> | undefined;
  #first: ReturnType<typeof setTimeout> | undefined;
  #off: (() => void) | undefined;
  #ticking = false;

  constructor(rt: Runtime, opts: { now?: () => Date } = {}) {
    this.#rt = rt;
    this.#now = opts.now ?? (() => new Date());
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  /** Starts the clock. Runs left running by an app that quit are over: failed, 'interrupted'. */
  start(): void {
    if (this.#timer) return;
    for (const r of this.#rt.store.listScheduleRuns({ status: 'running' })) {
      this.#finish(r, 'failed', 'interrupted');
    }
    this.#off = this.#rt.events.on((e) => this.#seen(e));
    this.#timer = setInterval(() => void this.check(), SCHEDULE_TICK_MS);
    this.#timer.unref?.();
    this.#first = setTimeout(() => void this.check(), FIRST_TICK_MS);
    this.#first.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#first) clearTimeout(this.#first);
    this.#timer = undefined;
    this.#first = undefined;
    this.#off?.();
    this.#off = undefined;
  }

  /** The tasks, each with its last run. */
  list(): ScheduleInfo[] {
    return this.#rt.store.listSchedules().map((s) => this.#withLast(s));
  }

  get(id: string): ScheduleInfo | undefined {
    const s = this.#rt.store.getSchedule(id);
    return s && this.#withLast(s);
  }

  runs(filter: { scheduleId?: string; status?: ScheduleRun['status']; limit?: number } = {}): ScheduleRun[] {
    return this.#rt.store.listScheduleRuns(filter);
  }

  /**
   * Adds a task, or with `id` changes one (given whole: a field left out is gone); its next run is worked out from now.
   * A change keeps the task on or off as it was, and its failures. Throws on a task that cannot run.
   */
  save(input: ScheduleInput & { id?: string }, by: 'user' | 'agent' = 'user'): ScheduleInfo {
    const problem = scheduleProblem(input) ?? (input.cwd?.trim() ? folderProblem(input.cwd.trim()) : null);
    if (problem) throw new Error(problem);
    const now = this.#now();
    const before = input.id ? this.#rt.store.getSchedule(input.id) : undefined;
    if (input.id && !before) throw new Error(`no scheduled task ${input.id}`);
    const next = nextRun(input.trigger.repeat, now);
    const s: ScheduleInfo = {
      id: before?.id ?? newId('sch'),
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      trigger: { type: 'time', repeat: input.trigger.repeat },
      ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      enabled: before ? before.enabled && next !== null : next !== null,
      nextAt: next && (before ? before.enabled : true) ? isoNow(next) : null,
      failures: before?.failures ?? 0,
      ...(before?.pausedAfterFailures && !before.enabled ? { pausedAfterFailures: true } : {}),
      createdBy: before?.createdBy ?? by,
      createdAt: before?.createdAt ?? isoNow(now),
      updatedAt: isoNow(now),
    };
    this.#rt.store.upsertSchedule(s);
    return this.#changed(s);
  }

  remove(id: string): boolean {
    if (!this.#rt.store.getSchedule(id)) return false;
    this.#rt.store.deleteSchedule(id);
    this.#rt.events.emit(this.#rt.eventHost, { type: 'schedule.deleted', id });
    return true;
  }

  /** On: the next run from now, the failures forgotten. Off: no next run. */
  setEnabled(id: string, enabled: boolean): ScheduleInfo {
    const s = this.#rt.store.getSchedule(id);
    if (!s) throw new Error(`no scheduled task ${id}`);
    const now = this.#now();
    const next = enabled ? nextRun(s.trigger.repeat, now) : null;
    const out: ScheduleInfo = { ...s, enabled: enabled && next !== null, nextAt: next ? isoNow(next) : null, failures: enabled ? 0 : s.failures, updatedAt: isoNow(now) };
    delete out.pausedAfterFailures;
    this.#rt.store.upsertSchedule(out);
    return this.#changed(out);
  }

  /** 立即运行: a run now, its times as they were. */
  runNow(id: string): ScheduleRun {
    const s = this.#rt.store.getSchedule(id);
    if (!s) throw new Error(`no scheduled task ${id}`);
    return this.#fire(s, this.#now(), false);
  }

  /** Looks for runs due now (every minute, after start, when the computer wakes). */
  async check(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#now();
      for (const s of this.#rt.store.listSchedules()) {
        if (!s.enabled || !s.nextAt || Date.parse(s.nextAt) > now.getTime()) continue;
        const due = new Date(s.nextAt);
        const late = now.getTime() - due.getTime() > LATE_MS;
        // the next one from now: however many were missed, one runs
        const next = s.trigger.repeat.kind === 'once' ? null : nextRun(s.trigger.repeat, now);
        const moved: ScheduleInfo = { ...s, nextAt: next ? isoNow(next) : null, enabled: next !== null, updatedAt: isoNow(now) };
        this.#rt.store.upsertSchedule(moved);
        this.#fire(moved, due, late);
      }
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * The task's run still going or waiting for the user, if any. One whose conversation was deleted is over (failed,
   * 'conversation_deleted'): the task would skip for ever otherwise.
   */
  #active(scheduleId: string): ScheduleRun | undefined {
    const st = this.#rt.store;
    const run = st.listScheduleRuns({ scheduleId, status: 'waiting', limit: 1 })[0] ?? st.listScheduleRuns({ scheduleId, status: 'running', limit: 1 })[0];
    if (run?.sessionId && !this.#rt.session(run.sessionId)) {
      this.#finish(run, 'failed', 'conversation_deleted');
      return undefined;
    }
    return run;
  }

  /**
   * The task with the run to show: the one going or waiting, else the latest that ran (a skip says nothing about how
   * the task does), else the latest skip.
   */
  #withLast(s: ScheduleInfo): ScheduleInfo {
    const recent = this.#rt.store.listScheduleRuns({ scheduleId: s.id, limit: 20 });
    const last = this.#active(s.id) ?? recent.find((r) => r.status !== 'skipped') ?? recent[0];
    return last ? { ...s, lastRun: last } : s;
  }

  #changed(s: ScheduleInfo): ScheduleInfo {
    const out = this.#withLast(s);
    this.#rt.events.emit(this.#rt.eventHost, { type: 'schedule.changed', schedule: out });
    return out;
  }

  #fire(s: ScheduleInfo, due: Date, late: boolean): ScheduleRun {
    const now = this.#now();
    const base = { id: newId('run'), scheduleId: s.id, dueAt: isoNow(due), startedAt: isoNow(now), ...(late ? { late: true } : {}) };
    // the previous run still going or waiting for the user: this one is skipped
    if (this.#active(s.id)) {
      const run: ScheduleRun = { ...base, status: 'skipped', endedAt: isoNow(now), reason: 'previous_waiting' };
      this.#rt.store.upsertScheduleRun(run);
      this.#rt.events.emit(this.#rt.eventHost, { type: 'schedule.run', run });
      this.#changed(s);
      return run;
    }
    let run: ScheduleRun = { ...base, status: 'running' };
    // a new conversation in a folder that is gone (moved, deleted, a drive not there): this run fails, nothing runs
    const gone = !s.sessionId && s.cwd ? folderProblem(s.cwd) : null;
    if (gone) return this.#finish(run, 'failed', gone.slice(0, gone.indexOf(':')), gone.slice(gone.indexOf(':') + 2));
    try {
      const same = s.sessionId ? this.#rt.session(s.sessionId) : undefined;
      const session =
        same ??
        this.#rt.createSession({
          title: s.title,
          ...(s.cwd ? { cwd: s.cwd } : {}),
          ...(s.providerId ? { providerId: s.providerId } : {}),
          ...(s.model ? { model: s.model } : {}),
        });
      run = { ...run, sessionId: session.id };
      this.#rt.store.upsertScheduleRun(run);
      session.send(s.prompt, { author: 'runtime', meta: { scheduleRun: { scheduleId: s.id, runId: run.id, title: s.title, dueAt: run.dueAt, ...(late ? { late: true } : {}) } } });
    } catch (err) {
      return this.#finish(run, 'failed', 'error', err instanceof Error ? err.message : String(err));
    }
    this.#rt.events.emit(this.#rt.eventHost, { type: 'schedule.run', run });
    this.#changed(this.#rt.store.getSchedule(s.id) ?? s);
    return run;
  }

  /** A conversation's run ended: the scheduled run in it (going, or waiting for the user) ends with it. */
  #seen(e: CoreEvent): void {
    if (e.type !== 'run.end' || !e.sessionId) return;
    const st = this.#rt.store;
    const run = st.listScheduleRuns({ sessionId: e.sessionId, status: 'waiting', limit: 1 })[0] ?? st.listScheduleRuns({ sessionId: e.sessionId, status: 'running', limit: 1 })[0];
    if (!run) return;
    const status = outcome(e.reason);
    if (status === 'waiting' && run.status === 'waiting') return;
    this.#finish(run, status, e.reason, e.detail);
  }

  #finish(run: ScheduleRun, status: ScheduleRun['status'], reason?: string, detail?: string): ScheduleRun {
    const now = this.#now();
    const out: ScheduleRun = {
      ...run,
      status,
      ...(status === 'waiting' ? {} : { endedAt: isoNow(now) }),
      ...(status === 'failed' && reason ? { reason } : {}),
      ...(status === 'failed' && detail ? { detail } : {}),
    };
    if (status !== 'failed') {
      delete out.reason;
      delete out.detail;
    }
    this.#rt.store.upsertScheduleRun(out);
    this.#rt.events.emit(this.#rt.eventHost, { type: 'schedule.run', run: out });
    const s = this.#rt.store.getSchedule(run.scheduleId);
    if (s && (status === 'done' || status === 'failed')) {
      const failures = status === 'failed' ? s.failures + 1 : 0;
      const pause = failures >= SCHEDULE_FAILURES_TO_PAUSE && s.enabled;
      const next: ScheduleInfo = { ...s, failures, updatedAt: isoNow(now), ...(pause ? { enabled: false, nextAt: null, pausedAfterFailures: true } : {}) };
      this.#rt.store.upsertSchedule(next);
      this.#changed(next);
    } else if (s) this.#changed(s);
    return out;
  }
}
