// Sessions and transcripts on the renderer side. Everything comes from the
// backend through `window.spica.agent` and its event stream.
import { useSyncExternalStore } from 'react';
import type { AgentApi, CoreEvent, Message, SessionInfo } from '@spica/protocol';
import { Store } from './external';
import { applyEvent, EMPTY_TRANSCRIPT, fromHistory, type Transcript } from './transcript';

export interface AgentView {
  sessions: SessionInfo[];
  loaded: boolean;
  activeId: string | null;
  transcripts: Record<string, Transcript>;
  /** Running total across all sessions, from `cost` events. */
  globalCostUsd: number;
  /** First thing the user said in each session, used to name untitled sessions. */
  firstLines: Record<string, string>;
  /** User-visible error from the last failed command. */
  notice?: string;
}

export interface AgentSource {
  agent: AgentApi;
  onAgentEvent(listener: (event: CoreEvent) => void): () => void;
}

export const NEW_CHAT_TITLE = '新对话';
/** Titles the backend gives sessions nobody named yet. */
const GENERIC_TITLES = new Set<string | null>([null, NEW_CHAT_TITLE, 'Top-level agent', 'Agent', '']);

/** What the sidebar and title bar call a session. */
export function displayTitle(s: SessionInfo, firstLines: Record<string, string>): string {
  if (s.title && !GENERIC_TITLES.has(s.title)) return s.title;
  const first = firstLines[s.id]?.replace(/\s+/g, ' ').trim();
  return first ? (first.length > 24 ? `${first.slice(0, 24)}…` : first) : NEW_CHAT_TITLE;
}

function firstUserText(messages: Message[]): string | undefined {
  const m = messages.find((x) => x.role === 'user' && x.kind === 'user');
  const b = m?.content.find((c) => c.type === 'text');
  return b?.type === 'text' ? b.text : undefined;
}

export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Electron prefixes remote errors with "Error invoking remote method '...': Error: ".
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '') || '操作没有成功，请再试一次。';
}

export class AgentStore {
  readonly state = new Store<AgentView>({ sessions: [], loaded: false, activeId: null, transcripts: {}, globalCostUsd: 0, firstLines: {} });
  readonly #api: AgentApi;
  #loading = new Set<string>();

  constructor(source: AgentSource) {
    this.#api = source.agent;
    source.onAgentEvent((e) => this.#onEvent(e));
  }

  async init(preferredId?: string): Promise<void> {
    try {
      const sessions = await this.#api.listSessions();
      const first = preferredId ?? sessions.find((s) => s.role === 'top')?.id ?? sessions[0]?.id ?? null;
      this.state.set((v) => ({ ...v, sessions, loaded: true, activeId: v.activeId ?? first }));
      if (first) await this.load(first);
    } catch (err) {
      this.state.set((v) => ({ ...v, loaded: true, notice: friendlyError(err) }));
    }
  }

  transcript(id: string | null): Transcript {
    return (id && this.state.get().transcripts[id]) || EMPTY_TRANSCRIPT;
  }

  async open(id: string): Promise<void> {
    this.state.set((v) => ({ ...v, activeId: id }));
    await this.load(id);
  }

  async load(id: string): Promise<void> {
    if (this.#loading.has(id) || this.state.get().transcripts[id]) return;
    this.#loading.add(id);
    try {
      const [messages, pending, info] = await Promise.all([this.#api.getMessages(id), this.#api.getPending(id), this.#api.getSession(id)]);
      const t = fromHistory(messages, pending);
      if (info && isLive(info.status)) t.run = { startedAt: Date.parse(info.updatedAt) || Date.now(), status: info.status };
      const first = firstUserText(messages);
      this.state.set((v) => ({
        ...v,
        transcripts: { ...v.transcripts, [id]: t },
        firstLines: first && !v.firstLines[id] ? { ...v.firstLines, [id]: first } : v.firstLines,
      }));
    } catch (err) {
      this.state.set((v) => ({ ...v, notice: friendlyError(err) }));
    } finally {
      this.#loading.delete(id);
    }
  }

  async newChat(): Promise<void> {
    await this.#guard(async () => {
      const s = await this.#api.createSession({ role: 'top' });
      this.state.set((v) => ({ ...v, sessions: [s, ...v.sessions], activeId: s.id, transcripts: { ...v.transcripts, [s.id]: { items: [] } } }));
    });
  }

  async send(id: string | null, text: string): Promise<void> {
    await this.#guard(async () => {
      let target = id;
      if (!target) {
        // Typing into the empty window starts a new conversation.
        const s = await this.#api.createSession({ role: 'top' });
        target = s.id;
        this.state.set((v) => ({ ...v, sessions: [s, ...v.sessions], activeId: s.id, transcripts: { ...v.transcripts, [s.id]: { items: [] } } }));
      }
      const result = await this.#api.send(target, text);
      if (!result.started) {
        // Queued into a running session: keep it visible until the agent takes it in.
        const sid = target;
        this.state.set((v) => {
          const t = v.transcripts[sid];
          if (!t || t.items.some((i) => i.id === result.messageId)) return v;
          const queued = [...(t.queued ?? []), { id: result.messageId, text }];
          return { ...v, transcripts: { ...v.transcripts, [sid]: { ...t, queued } } };
        });
      }
    });
  }

  async resume(id: string): Promise<void> {
    await this.#guard(() => this.#api.resume(id));
  }

  async stop(id: string): Promise<void> {
    await this.#guard(() => this.#api.abort(id));
  }

  async answer(id: string, callId: string, answer: string): Promise<void> {
    await this.#guard(() => this.#api.answer(id, callId, answer));
  }

  async confirm(id: string, callId: string, approved: boolean): Promise<void> {
    await this.#guard(() => this.#api.confirm(id, callId, approved));
  }

  dismissNotice(): void {
    this.state.set((v) => ({ ...v, notice: undefined }));
  }

  async #guard(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.state.set((v) => ({ ...v, notice: friendlyError(err) }));
    }
  }

  #onEvent(e: CoreEvent): void {
    this.state.set((v) => {
      let { sessions, globalCostUsd } = v;
      if (e.type === 'status' || e.type === 'cost' || e.type === 'session.renamed') {
        sessions = sessions.map((s) => {
          if (s.id !== e.sessionId) return s;
          if (e.type === 'status') return { ...s, status: e.status, updatedAt: e.at };
          if (e.type === 'session.renamed') return { ...s, title: e.title };
          return e.scope === 'session' ? { ...s, costUsd: e.spentUsd } : s;
        });
        if (e.type === 'cost' && e.scope === 'global') globalCostUsd = e.spentUsd;
      }
      const current = v.transcripts[e.sessionId];
      const transcripts = current ? { ...v.transcripts, [e.sessionId]: applyEvent(current, e) } : v.transcripts;
      return { ...v, sessions, globalCostUsd, transcripts };
    });
    if (e.type === 'message' && e.message.role === 'user' && e.message.kind === 'user' && !this.state.get().firstLines[e.sessionId]) {
      const first = firstUserText([e.message]);
      if (first) this.state.set((v) => ({ ...v, firstLines: { ...v.firstLines, [e.sessionId]: first } }));
    }
    // New sessions (a sub-agent was spawned): refresh the tree (cheap; the list is small).
    if (e.type === 'child.spawned' || (e.type === 'status' && !this.state.get().sessions.some((s) => s.id === e.sessionId))) void this.#refreshSessions();
    if (e.type === 'run.end') void this.#reload(e.sessionId);
  }

  async #refreshSessions(): Promise<void> {
    try {
      const sessions = await this.#api.listSessions();
      this.state.set((v) => ({ ...v, sessions }));
    } catch {
      // Keep the current list.
    }
  }

  /** After a run, the stored history is the truth; rebuild from it, keeping the finished-run info. */
  async #reload(id: string): Promise<void> {
    try {
      const [messages, pending] = await Promise.all([this.#api.getMessages(id), this.#api.getPending(id)]);
      this.state.set((v) => {
        const prev = v.transcripts[id];
        const next = fromHistory(messages, pending);
        if (prev?.lastRun) next.lastRun = prev.lastRun;
        if (prev?.error) next.error = prev.error;
        if (prev?.run) next.run = prev.run;
        return { ...v, transcripts: { ...v.transcripts, [id]: next } };
      });
    } catch {
      // Keep the live view.
    }
  }
}

function isLive(status: SessionInfo['status']): boolean {
  return status === 'queued' || status === 'thinking' || status === 'tool' || status === 'awaiting_answer' || status === 'awaiting_confirm';
}

export function useAgent(store: AgentStore): AgentView {
  return useSyncExternalStore(store.state.subscribe, store.state.get);
}
