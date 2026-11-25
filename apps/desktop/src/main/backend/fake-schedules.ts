// The demo backend's scheduled tasks: kept in memory, times worked out as the core does; a run made with 立即运行 is
// done at once without a conversation (the demo has no clock that starts runs).
import { nextRun, scheduleProblem, type ScheduleInfo, type ScheduleInput, type ScheduleRun } from '@spica/protocol';
import { isoAt } from './time';

export type ScheduleEventBody = { type: 'schedule.changed'; schedule: ScheduleInfo } | { type: 'schedule.deleted'; id: string } | { type: 'schedule.run'; run: ScheduleRun };

export class FakeSchedules {
  readonly #now: () => Date;
  readonly #emit: (body: ScheduleEventBody) => void;
  readonly #items = new Map<string, ScheduleInfo>();
  readonly #runs: ScheduleRun[] = [];
  #ids = 0;

  constructor(now: () => Date, emit: (body: ScheduleEventBody) => void) {
    this.#now = now;
    this.#emit = emit;
  }

  #with(s: ScheduleInfo): ScheduleInfo {
    const last = this.#runs.find((r) => r.scheduleId === s.id);
    return structuredClone(last ? { ...s, lastRun: last } : s);
  }

  list(): ScheduleInfo[] {
    return [...this.#items.values()].map((s) => this.#with(s));
  }

  save(input: ScheduleInput & { id?: string }): ScheduleInfo {
    const problem = scheduleProblem(input);
    if (problem) throw new Error(problem);
    const before = input.id ? this.#items.get(input.id) : undefined;
    if (input.id && !before) throw new Error(`no scheduled task ${input.id}`);
    const now = this.#now();
    const next = nextRun(input.trigger.repeat, now);
    const s: ScheduleInfo = {
      ...input,
      id: before?.id ?? `sch-${++this.#ids}`,
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      enabled: next !== null,
      nextAt: next ? isoAt(next) : null,
      failures: 0,
      createdBy: before?.createdBy ?? 'user',
      createdAt: before?.createdAt ?? isoAt(now),
      updatedAt: isoAt(now),
    };
    this.#items.set(s.id, s);
    const out = this.#with(s);
    this.#emit({ type: 'schedule.changed', schedule: out });
    return out;
  }

  remove(id: string): boolean {
    if (!this.#items.delete(id)) return false;
    this.#emit({ type: 'schedule.deleted', id });
    return true;
  }

  setEnabled(id: string, enabled: boolean): ScheduleInfo {
    const s = this.#items.get(id);
    if (!s) throw new Error(`no scheduled task ${id}`);
    const next = enabled ? nextRun(s.trigger.repeat, this.#now()) : null;
    const changed: ScheduleInfo = { ...s, enabled: next !== null, nextAt: next ? isoAt(next) : null, failures: enabled ? 0 : s.failures, updatedAt: isoAt(this.#now()) };
    delete changed.pausedAfterFailures;
    this.#items.set(id, changed);
    const out = this.#with(changed);
    this.#emit({ type: 'schedule.changed', schedule: out });
    return out;
  }

  run(id: string): ScheduleRun {
    const s = this.#items.get(id);
    if (!s) throw new Error(`no scheduled task ${id}`);
    const at = isoAt(this.#now());
    const run: ScheduleRun = { id: `run-${++this.#ids}`, scheduleId: id, dueAt: at, startedAt: at, endedAt: at, status: 'done' };
    this.#runs.unshift(run);
    this.#emit({ type: 'schedule.run', run: structuredClone(run) });
    this.#emit({ type: 'schedule.changed', schedule: this.#with(s) });
    return structuredClone(run);
  }

  runs(filter: { scheduleId?: string; status?: ScheduleRun['status']; limit?: number } = {}): ScheduleRun[] {
    const list = this.#runs.filter((r) => (!filter.scheduleId || r.scheduleId === filter.scheduleId) && (!filter.status || r.status === filter.status));
    return structuredClone(filter.limit !== undefined ? list.slice(0, filter.limit) : list);
  }
}
