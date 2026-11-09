// Sessions and transcripts on the renderer side. Everything comes from the
// backend through `window.spica.agent` and its event stream.
import { useSyncExternalStore } from 'react';
import type { AgentApi, ApprovalMode, CoreEvent, Message, ProjectInfo, ProjectLogEntry, SessionInfo } from '@spica/protocol';
import { Store } from './external';
import { applyEvent, EMPTY_TRANSCRIPT, fromHistory, humanError, type Transcript } from './transcript';

export interface AgentView {
  sessions: SessionInfo[];
  loaded: boolean;
  activeId: string | null;
  transcripts: Record<string, Transcript>;
  /** Running total across all sessions, from `cost` events. */
  globalCostUsd: number;
  /** First thing the user said in each session, used to name untitled sessions. */
  firstLines: Record<string, string>;
  projects: ProjectInfo[];
  /** The core's standing top-level agent (it starts projects); null until known. */
  topId: string | null;
  /** Key actions per project, newest first (from getProject, then live project.activity). */
  activity: Record<string, ProjectLogEntry[]>;
  /** User-visible error from the last failed command. */
  notice?: string;
  /** Choices in the empty window, used when its first message starts a conversation. */
  draft: NewChatDraft;
}

/** What the input box offers before a conversation exists. Empty = the core's defaults. */
export interface NewChatDraft {
  cwd?: string;
  providerId?: string;
  model?: string;
  approvalMode: ApprovalMode;
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
  const msg = raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '').trim();
  if (!msg) return '操作没有成功，请再试一次。';
  // Messages the shell already wrote in Chinese pass through; backend English is translated.
  return /[\u4e00-\u9fff]/.test(msg) ? msg : humanError(msg);
}

export class AgentStore {
  readonly state = new Store<AgentView>({ sessions: [], loaded: false, activeId: null, transcripts: {}, globalCostUsd: 0, firstLines: {}, projects: [], activity: {}, topId: null, draft: { approvalMode: 'manual' } });
  readonly #api: AgentApi;
  #loading = new Set<string>();

  constructor(source: AgentSource) {
    this.#api = source.agent;
    source.onAgentEvent((e) => this.#onEvent(e));
  }

  async init(preferredId?: string): Promise<void> {
    void this.#refreshProjects();
    if (this.#api.getTopSession) {
      // Projects hang under the core's top-level agent; knowing it lets the sidebar name it.
      void this.#api
        .getTopSession()
        .then((top) => this.state.set((v) => ({ ...v, topId: top.id, sessions: v.sessions.some((s) => s.id === top.id) ? v.sessions : [top, ...v.sessions] })))
        .catch(() => {});
    }
    try {
      const sessions = await this.#api.listSessions();
      const first = preferredId ?? sessions.find((s) => s.role === 'top')?.id ?? sessions[0]?.id ?? null;
      this.state.set((v) => ({ ...v, sessions, loaded: true, activeId: v.activeId ?? first }));
      void this.#nameUntitled(sessions);
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

  /** Shows an empty conversation; the session is created when the first message is sent. */
  newChat(): void {
    this.state.set((v) => ({ ...v, activeId: null }));
  }

  async send(id: string | null, text: string, attachments: string[] = []): Promise<void> {
    await this.#guard(async () => {
      let target = id;
      if (!target) {
        // Typing into the empty window: the assistant's own thread while it is still
        // empty (first use, and no other folder was chosen), otherwise a new conversation.
        const draft = this.state.get().draft;
        const top = draft.cwd ? null : await this.#emptyTop();
        if (top) {
          target = top.id;
          if (draft.providerId && draft.model && this.#api.setSessionModel) await this.#api.setSessionModel(top.id, draft.providerId, draft.model);
          if (draft.approvalMode !== top.approvalMode && this.#api.setApprovalMode) await this.#api.setApprovalMode(top.id, draft.approvalMode);
          this.state.set((v) => ({ ...v, activeId: top.id, transcripts: { ...v.transcripts, [top.id]: v.transcripts[top.id] ?? { items: [] } } }));
        } else {
          const s = await this.#api.createSession({
            role: 'top',
            ...(draft.cwd ? { cwd: draft.cwd } : {}),
            ...(draft.providerId && draft.model ? { providerId: draft.providerId, model: draft.model } : {}),
            approvalMode: draft.approvalMode,
          });
          target = s.id;
          this.state.set((v) => ({ ...v, sessions: [s, ...v.sessions], activeId: s.id, transcripts: { ...v.transcripts, [s.id]: { items: [] } } }));
        }
        this.state.set((v) => ({ ...v, draft: { approvalMode: v.draft.approvalMode } }));
      }
      const result = await this.#api.send(target, text, attachments.length ? { attachments: attachments.map((path) => ({ path })) } : undefined);
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

  /** The assistant's default thread when nothing was said in it yet (asks the core again if it failed at start, e.g. before a model was set). */
  async #emptyTop(): Promise<SessionInfo | null> {
    if (!this.#api.getTopSession) return null;
    try {
      const top = await this.#api.getTopSession();
      this.state.set((v) => ({ ...v, topId: top.id, sessions: v.sessions.some((x) => x.id === top.id) ? v.sessions : [top, ...v.sessions] }));
      const known = this.state.get().transcripts[top.id];
      const count = known ? known.items.length : (await this.#api.getMessages(top.id)).length;
      return count === 0 ? top : null;
    } catch {
      return null;
    }
  }

  /** Untitled conversations are named by their first line; after a restart that line comes from history. */
  async #nameUntitled(sessions: SessionInfo[]): Promise<void> {
    const known = this.state.get().firstLines;
    const todo = sessions.filter((x) => x.role === 'top' && GENERIC_TITLES.has(x.title) && !known[x.id]).slice(0, 100);
    const found = await Promise.all(
      todo.map(async (x) => {
        try {
          return [x.id, firstUserText(await this.#api.getMessages(x.id))] as const;
        } catch {
          return [x.id, undefined] as const;
        }
      }),
    );
    const add = Object.fromEntries(found.filter((f): f is readonly [string, string] => Boolean(f[1])));
    if (Object.keys(add).length) this.state.set((v) => ({ ...v, firstLines: { ...add, ...v.firstLines } }));
  }

  /** Choices for the next new conversation (folder, model, approval). */
  setDraft(patch: Partial<NewChatDraft>): void {
    this.state.set((v) => ({ ...v, draft: { ...v.draft, ...patch } }));
  }

  /** Model for this conversation from its next step on (the core notes the change). */
  async setModel(id: string, providerId: string, model: string): Promise<void> {
    const api = this.#api;
    if (!api.setSessionModel) return;
    await this.#guard(async () => this.#replace(await api.setSessionModel!(id, providerId, model)));
  }

  /** manual: every irreversible step asks; auto: they run and are recorded (the guard's still ask). */
  async setApproval(id: string, mode: ApprovalMode): Promise<void> {
    const api = this.#api;
    if (!api.setApprovalMode) return;
    await this.#guard(async () => this.#replace(await api.setApprovalMode!(id, mode)));
  }

  #replace(info: SessionInfo): void {
    this.state.set((v) => ({ ...v, sessions: v.sessions.map((s) => (s.id === info.id ? { ...s, ...info, title: s.title ?? info.title } : s)) }));
  }

  /** Names a session; null goes back to the automatic name. */
  async rename(id: string, title: string | null): Promise<void> {
    await this.#guard(async () => {
      const s = await this.#api.renameSession(id, title);
      this.state.set((v) => ({ ...v, sessions: v.sessions.map((x) => (x.id === id ? { ...x, title: s.title } : x)) }));
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

  /** Creates a project (the core attaches its manager) and opens the manager's conversation. Resolves to a problem in words, or null. */
  async createProject(input: { name: string; folder?: string; brief?: string }, after?: (p: ProjectInfo) => Promise<void>): Promise<string | null> {
    if (!this.#api.createProject) return '这个版本还不能建项目。';
    try {
      const p = await this.#api.createProject(input);
      this.state.set((v) => ({ ...v, projects: [p, ...v.projects.filter((x) => x.id !== p.id)] }));
      if (after) await after(p);
      await this.#refreshSessions();
      await this.open(p.managerSessionId);
      return null;
    } catch (err) {
      return friendlyError(err);
    }
  }

  /** Renames a project (its manager's conversation takes the name). Resolves to a problem in words, or null. */
  async renameProject(projectId: string, name: string): Promise<string | null> {
    if (!this.#api.renameProject) return '这个版本还不能给项目改名。';
    try {
      const p = await this.#api.renameProject(projectId, name);
      this.state.set((v) => ({
        ...v,
        projects: v.projects.map((x) => (x.id === p.id ? p : x)),
        sessions: v.sessions.map((s) => (s.id === p.managerSessionId ? { ...s, title: p.name } : s)),
      }));
      return null;
    } catch (err) {
      const msg = friendlyError(err);
      this.state.set((v) => ({ ...v, notice: msg }));
      return msg;
    }
  }

  /** Deletes a project from Spica (its conversations; never its folder). The core's events take it off the list. */
  async deleteProject(projectId: string): Promise<string | null> {
    if (!this.#api.deleteProject) return '这个版本还不能删除项目。';
    try {
      await this.#api.deleteProject(projectId);
      await this.#refreshProjects();
      await this.#refreshSessions();
      return null;
    } catch (err) {
      const msg = friendlyError(err);
      this.state.set((v) => ({ ...v, notice: msg }));
      return msg;
    }
  }

  /** Loads a project's recent activity once (live entries keep coming as events). */
  async loadProject(projectId: string): Promise<void> {
    if (!this.#api.getProject || this.state.get().activity[projectId]) return;
    try {
      const d = await this.#api.getProject(projectId);
      if (d) this.state.set((v) => ({ ...v, activity: { ...v.activity, [projectId]: v.activity[projectId] ?? d.recentLog } }));
    } catch {
      // Activity is extra information; the conversation works without it.
    }
  }

  async #refreshProjects(): Promise<void> {
    if (!this.#api.listProjects) return;
    try {
      const projects = await this.#api.listProjects();
      this.state.set((v) => ({ ...v, projects }));
    } catch {
      // Keep the current list.
    }
  }

  /** The core restarted after a crash: everything comes back from its database. */
  async reloadAll(): Promise<void> {
    const active = this.state.get().activeId;
    this.state.set((v) => ({ ...v, transcripts: {}, activity: {} }));
    void this.#refreshProjects();
    try {
      const sessions = await this.#api.listSessions();
      this.state.set((v) => ({ ...v, sessions }));
      void this.#nameUntitled(sessions);
      if (active) await this.load(active);
    } catch (err) {
      this.state.set((v) => ({ ...v, notice: friendlyError(err) }));
    }
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
    if (e.type === 'session.updated') this.#replace(e.info);
    if (e.type === 'session.deleted') {
      const gone = e.sessionId;
      this.state.set((v) => {
        const transcripts = { ...v.transcripts };
        delete transcripts[gone];
        return {
          ...v,
          sessions: v.sessions.filter((s) => s.id !== gone),
          transcripts,
          activeId: v.activeId === gone ? v.topId : v.activeId,
        };
      });
    }
    if (e.type === 'project.deleted') {
      const pid = e.projectId;
      this.state.set((v) => ({ ...v, projects: v.projects.filter((p) => p.id !== pid) }));
    }
    if (e.type === 'project.created' || e.type === 'project.updated') {
      const p = e.project;
      this.state.set((v) => ({ ...v, projects: [p, ...v.projects.filter((x) => x.id !== p.id)] }));
      void this.#refreshSessions();
    }
    if (e.type === 'project.activity') {
      const entry = e.entry;
      this.state.set((v) => {
        const list = v.activity[entry.projectId] ?? [];
        if (list.some((x) => x.id === entry.id)) return v;
        return { ...v, activity: { ...v.activity, [entry.projectId]: [entry, ...list].slice(0, 50) } };
      });
    }
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
        // file.card details only arrive as events; keep them across the reload.
        if (prev?.fileCards) next.fileCards = { ...prev.fileCards, ...(next.fileCards ?? {}) };
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
