// The inbox on the renderer side: mail the core's pipeline fetched and sorted
// (listMail), kept fresh by the mail.* events, and the user's handling of it
// (mailFeedback). Nothing here sends mail; the core never does either.
import { useSyncExternalStore } from 'react';
import type { AgentApi, CoreEvent, MailFeedback, MailItem } from '@spica/protocol';
import { Store } from './external';
import { friendlyError } from './agent';
import { flaggedMailIds } from './transcript';

/** Template of the pipeline's own thread (it is a top-level session). */
const TRIAGE_TEMPLATE = 'mail-triage';

export interface MailView {
  /** False when this backend has no mail pipeline. */
  supported: boolean;
  loaded: boolean;
  items: MailItem[];
  /** A fetch the user started is running. */
  polling: boolean;
  /** When mail was last fetched (from mail.polled), ISO; null until known. */
  lastPolledAt: string | null;
  /** New mails the last 现在查收 brought (0: none); null before one ran. */
  lastAdded: number | null;
  /** Why the last fetch or action did not work, in words; empty when fine. */
  problem: string;
  /** The pipeline's own thread (hidden from the sidebar). */
  threadId: string | null;
  /** Mail whose text carried instructions (the core flagged them and told the model to ignore them). */
  flagged: string[];
  /** The provider and model the core sends mail to for sorting (from mail.configured); null until known. */
  triageModel: { providerId: string; model: string } | null;
}

export interface MailSource {
  agent: AgentApi;
  onAgentEvent(listener: (event: CoreEvent) => void): () => void;
}

export class MailStore {
  readonly state: Store<MailView>;
  readonly #api: AgentApi;

  constructor(source: MailSource) {
    this.#api = source.agent;
    this.state = new Store<MailView>({
      supported: Boolean(source.agent.listMail),
      loaded: false,
      items: [],
      polling: false,
      lastPolledAt: null,
      lastAdded: null,
      problem: '',
      threadId: null,
      flagged: [],
      triageModel: null,
    });
    source.onAgentEvent((e) => this.#onEvent(e));
  }

  /** Loads everything (at start, and after the core restarted). */
  async reload(): Promise<void> {
    if (!this.#api.listMail) return;
    try {
      const items = await this.#api.listMail({ limit: 500 });
      this.state.set((v) => ({ ...v, items, loaded: true }));
      void this.#loadFlags();
    } catch (err) {
      this.state.set((v) => ({ ...v, loaded: true, problem: friendlyError(err) }));
    }
  }

  /** Fetch and sort now instead of waiting for the interval. */
  async pollNow(): Promise<void> {
    if (!this.#api.pollMail || this.state.get().polling) return;
    this.state.set((v) => ({ ...v, polling: true, problem: '' }));
    const before = new Set(this.state.get().items.map((m) => m.id));
    try {
      await this.#api.pollMail();
      this.state.set((v) => ({ ...v, lastPolledAt: new Date().toISOString() }));
      await this.reload();
      this.state.set((v) => ({ ...v, lastAdded: v.items.filter((m) => !before.has(m.id)).length }));
    } catch (err) {
      this.state.set((v) => ({ ...v, problem: friendlyError(err) }));
    } finally {
      this.state.set((v) => ({ ...v, polling: false }));
    }
  }

  /** Mails whose 采纳 / 忽略 / 更改项目 is on its way: a second click is dropped. */
  readonly #sending = new Set<string>();

  async feedback(mailId: string, action: MailFeedback['action'], projectId?: string): Promise<void> {
    if (!this.#api.mailFeedback || this.#sending.has(mailId)) return;
    this.#sending.add(mailId);
    try {
      const item = await this.#api.mailFeedback(mailId, { action, ...(projectId ? { projectId } : {}) });
      this.#upsert(item);
    } catch (err) {
      this.state.set((v) => ({ ...v, problem: friendlyError(err) }));
    } finally {
      this.#sending.delete(mailId);
    }
  }

  /** Which mails were flagged, rebuilt from the triage thread's history (the core marks the messages it fenced). */
  async #loadFlags(): Promise<void> {
    try {
      let thread = this.state.get().threadId;
      if (!thread) thread = (await this.#api.listSessions()).find((s) => s.templateId === TRIAGE_TEMPLATE && !s.parentId)?.id ?? null;
      if (!thread) return;
      const ids = (await this.#api.getMessages(thread)).flatMap((m) => flaggedMailIds(m.meta?.untrusted));
      if (ids.length) this.#flag(ids);
    } catch {
      // A mark, not essential: the inbox works without it.
    }
  }

  #flag(ids: string[]): void {
    this.state.set((v) => {
      const add = ids.filter((id) => !v.flagged.includes(id));
      return add.length ? { ...v, flagged: [...v.flagged, ...add] } : v;
    });
  }

  dismissProblem(): void {
    this.state.set((v) => ({ ...v, problem: '' }));
  }

  #upsert(item: MailItem): void {
    this.state.set((v) => {
      const i = v.items.findIndex((m) => m.id === item.id);
      const items = i < 0 ? [item, ...v.items] : v.items.map((m, k) => (k === i ? item : m));
      return { ...v, items };
    });
  }

  #onEvent(e: CoreEvent): void {
    if (e.type === 'mail.triaged' || e.type === 'mail.routed' || e.type === 'mail.feedback') {
      this.#upsert(e.item);
      if (this.state.get().threadId !== e.sessionId) this.state.set((v) => ({ ...v, threadId: e.sessionId }));
    } else if (e.type === 'mail.configured') {
      const tm = e.settings.triageModel;
      this.state.set((v) => ({ ...v, triageModel: tm ? { providerId: tm.providerId, model: tm.model } : null }));
    } else if (e.type === 'guard.flagged' && e.note.kind === 'mail') {
      this.#flag(flaggedMailIds([e.note]));
    } else if (e.type === 'mail.polled') {
      this.state.set((v) => ({ ...v, threadId: e.sessionId, lastPolledAt: e.at }));
      // New mail is stored before it is sorted; fetch it so it shows as 「正在分类」.
      if (e.added > 0) void this.reload();
    } else if (e.type === 'error' && e.sessionId === this.state.get().threadId && /^mail source /.test(e.message)) {
      this.state.set((v) => ({ ...v, problem: '邮件检查失败：邮件插件无响应。' }));
    }
  }
}

export function useMail(store: MailStore): MailView {
  return useSyncExternalStore(store.state.subscribe, store.state.get);
}
