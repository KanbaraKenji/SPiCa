// 定时任务 on the renderer side: the core's scheduled tasks (listSchedules), kept fresh by the schedule.* events, and
// what the page does to them (save, turn on / off, run now, delete). The core runs them; nothing here does.
import { useSyncExternalStore } from 'react';
import type { AgentApi, CoreEvent, ScheduleInfo, ScheduleInput, ScheduleRun } from '@spica/protocol';
import { Store } from './external';
import { friendlyError } from './agent';
import { t } from '../../../shared/i18n';

export interface SchedulesView {
  /** False when this backend has no scheduled tasks. */
  supported: boolean;
  loaded: boolean;
  /** Oldest first, as set up. */
  items: ScheduleInfo[];
  /** Why the last action did not work, in words; empty when fine. */
  problem: string;
}

export interface SchedulesSource {
  agent: AgentApi;
  onAgentEvent(listener: (event: CoreEvent) => void): () => void;
}

export class SchedulesStore {
  readonly state: Store<SchedulesView>;
  readonly #api: AgentApi;

  constructor(source: SchedulesSource) {
    this.#api = source.agent;
    this.state = new Store<SchedulesView>({ supported: Boolean(source.agent.listSchedules), loaded: false, items: [], problem: '' });
    source.onAgentEvent((e) => this.#onEvent(e));
  }

  async reload(): Promise<void> {
    if (!this.#api.listSchedules) return;
    try {
      const items = await this.#api.listSchedules();
      this.state.set((v) => ({ ...v, items, loaded: true }));
    } catch (err) {
      this.state.set((v) => ({ ...v, loaded: true, problem: friendlyError(err) }));
    }
  }

  /** Adds one, or with `id` changes it. The problem in words when it did not work, else ''. */
  async save(input: ScheduleInput & { id?: string }): Promise<string> {
    if (!this.#api.saveSchedule) return '';
    try {
      this.#upsert(await this.#api.saveSchedule(input));
      return '';
    } catch (err) {
      // the core's folder codes, in the window's words
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes('folder_missing')) return t('文件夹不存在');
      if (raw.includes('folder_invalid')) return t('文件夹路径不对');
      return friendlyError(err);
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    // the switch moves at once; the core's answer (or the event) settles it
    this.state.set((v) => ({ ...v, items: v.items.map((s) => (s.id === id ? { ...s, enabled } : s)) }));
    await this.#act(async () => this.#upsert(await this.#api.setScheduleEnabled!(id, enabled)));
  }

  async runNow(id: string): Promise<ScheduleRun | undefined> {
    let run: ScheduleRun | undefined;
    await this.#act(async () => {
      run = await this.#api.runSchedule!(id);
    });
    return run;
  }

  async remove(id: string): Promise<void> {
    await this.#act(async () => {
      await this.#api.deleteSchedule!(id);
      this.#drop(id);
    });
  }

  dismissProblem(): void {
    this.state.set((v) => ({ ...v, problem: '' }));
  }

  async #act(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.state.set((v) => ({ ...v, problem: friendlyError(err) }));
      void this.reload();
    }
  }

  #upsert(item: ScheduleInfo): void {
    this.state.set((v) => {
      const i = v.items.findIndex((s) => s.id === item.id);
      return { ...v, items: i < 0 ? [...v.items, item] : v.items.map((s, k) => (k === i ? item : s)) };
    });
  }

  #drop(id: string): void {
    this.state.set((v) => (v.items.some((s) => s.id === id) ? { ...v, items: v.items.filter((s) => s.id !== id) } : v));
  }

  #onEvent(e: CoreEvent): void {
    if (e.type === 'schedule.changed') this.#upsert(e.schedule);
    else if (e.type === 'schedule.deleted') this.#drop(e.id);
    // schedule.run is followed by schedule.changed, which carries the run to show (a waiting one stays shown when the next is skipped)
  }
}

export function useSchedules(store: SchedulesStore): SchedulesView {
  return useSyncExternalStore(store.state.subscribe, store.state.get);
}

/** The runs that wait for the user, and the tasks turned off after failing: 收件箱's 定时任务 cards. */
export function schedulesNeedingYou(items: ScheduleInfo[]): ScheduleInfo[] {
  return items.filter((s) => s.lastRun?.status === 'waiting' || (s.pausedAfterFailures && !s.enabled));
}
