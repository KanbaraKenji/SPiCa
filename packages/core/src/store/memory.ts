// In-memory store (tests and ephemeral runs).
import type { MailItem, MemoryItem, Message, ProjectInfo, ProjectLogEntry, SupersededMark, TraceRecord, WorkObject } from '../types.ts';
import type { PendingRecord, RelayRecord, SenderDecision, SessionRecord, Store, ToolCallRecord } from './types.ts';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #messages = new Map<string, Message[]>();
  readonly #toolCalls = new Map<string, ToolCallRecord>();
  readonly #queued = new Map<string, Message[]>();
  readonly #pending = new Map<string, PendingRecord>();
  readonly #relays: RelayRecord[] = [];
  readonly #traces: TraceRecord[] = [];
  readonly #projects = new Map<string, ProjectInfo>();
  readonly #projectLog: ProjectLogEntry[] = [];
  readonly #objects = new Map<string, WorkObject>();
  readonly #mail = new Map<string, MailItem>();
  readonly #senders = new Map<string, SenderDecision>();
  readonly #memories = new Map<number, MemoryItem>();
  #memorySeq = 0;

  putMemory(m: MemoryItem): MemoryItem {
    const item = m.id ? clone(m) : { ...clone(m), id: ++this.#memorySeq };
    this.#memorySeq = Math.max(this.#memorySeq, item.id);
    this.#memories.set(item.id, item);
    return clone(item);
  }
  getMemory(id: number): MemoryItem | undefined {
    const m = this.#memories.get(id);
    return m && clone(m);
  }
  listMemories(owner: string, opts: { all?: boolean } = {}): MemoryItem[] {
    return [...this.#memories.values()]
      .filter((m) => m.owner === owner && (opts.all || m.status === 'active'))
      .sort((a, b) => a.id - b.id)
      .map(clone);
  }

  upsertMail(m: MailItem): void {
    this.#mail.set(m.id, clone(m));
  }
  getMail(id: string): MailItem | undefined {
    const m = this.#mail.get(id);
    return m && clone(m);
  }
  listMail(filter: { status?: MailItem['status']; projectId?: string; limit?: number } = {}): MailItem[] {
    return [...this.#mail.values()]
      .filter((m) => (!filter.status || m.status === filter.status) && (!filter.projectId || m.triage?.projectId === filter.projectId))
      .slice(0, filter.limit ?? 1000)
      .map(clone);
  }
  setSenderDecision(address: string, d: SenderDecision): void {
    this.#senders.set(address.toLowerCase(), clone(d));
  }
  getSenderDecision(address: string): SenderDecision | undefined {
    const d = this.#senders.get(address.toLowerCase());
    return d && clone(d);
  }

  upsertProject(p: ProjectInfo): void {
    // the same shape the SQLite store gives back: unread is always a number
    this.#projects.set(p.id, clone({ ...p, unread: p.unread ?? 0 }));
  }
  deleteProject(id: string): void {
    this.#projects.delete(id);
    const keep = this.#projectLog.filter((e) => e.projectId !== id);
    this.#projectLog.splice(0, this.#projectLog.length, ...keep);
    for (const [k, o] of this.#objects) if (o.projectId === id) this.#objects.delete(k);
    for (const [k, d] of this.#senders) if (d.decision === 'project' && d.projectId === id) this.#senders.delete(k);
  }
  deleteSession(id: string): void {
    this.#sessions.delete(id);
    this.#messages.delete(id);
    this.#queued.delete(id);
    for (const [k, t] of this.#toolCalls) if (t.sessionId === id) this.#toolCalls.delete(k);
    for (const [k, p] of this.#pending) if (p.sessionId === id) this.#pending.delete(k);
    const keep = this.#relays.filter((r) => r.parentId !== id && r.childId !== id);
    this.#relays.splice(0, this.#relays.length, ...keep);
  }
  getProject(id: string): ProjectInfo | undefined {
    const p = this.#projects.get(id);
    return p && clone(p);
  }
  listProjects(): ProjectInfo[] {
    return [...this.#projects.values()].map(clone);
  }
  appendProjectLog(e: ProjectLogEntry): void {
    this.#projectLog.push(clone(e));
  }
  listProjectLog(projectId: string, limit = 50): ProjectLogEntry[] {
    return this.#projectLog.filter((e) => e.projectId === projectId).reverse().slice(0, limit).map(clone);
  }
  upsertWorkObject(o: WorkObject): void {
    this.#objects.set(o.id, clone(o));
  }
  listWorkObjects(projectId: string): WorkObject[] {
    return [...this.#objects.values()].filter((o) => o.projectId === projectId).map(clone);
  }

  upsertSession(rec: SessionRecord): void {
    this.#sessions.set(rec.id, clone(rec));
  }
  getSession(id: string): SessionRecord | undefined {
    const r = this.#sessions.get(id);
    return r && clone(r);
  }
  listSessions(): SessionRecord[] {
    return [...this.#sessions.values()].map(clone);
  }

  appendMessage(msg: Message): void {
    const list = this.#messages.get(msg.sessionId) ?? [];
    list.push(clone(msg));
    this.#messages.set(msg.sessionId, list);
  }
  updateMessage(msg: Message): void {
    const list = this.#messages.get(msg.sessionId) ?? [];
    const i = list.findIndex((m) => m.id === msg.id);
    if (i >= 0) list[i] = clone(msg);
  }
  listMessages(sessionId: string): Message[] {
    return (this.#messages.get(sessionId) ?? []).map(clone);
  }
  supersedeMessages(sessionId: string, ids: readonly string[], mark: SupersededMark): void {
    const wanted = new Set(ids);
    for (const m of this.#messages.get(sessionId) ?? []) if (wanted.has(m.id)) m.superseded = { ...mark };
  }

  upsertToolCall(rec: ToolCallRecord): void {
    this.#toolCalls.set(`${rec.sessionId}|${rec.messageId}|${rec.id}`, clone(rec));
  }
  listToolCalls(sessionId: string, messageId?: string): ToolCallRecord[] {
    return [...this.#toolCalls.values()]
      .filter((t) => t.sessionId === sessionId && (!messageId || t.messageId === messageId))
      .map(clone);
  }

  putQueued(msg: Message): void {
    const list = this.#queued.get(msg.sessionId) ?? [];
    list.push(clone(msg));
    this.#queued.set(msg.sessionId, list);
  }
  deleteQueued(sessionId: string, messageId: string): void {
    this.#queued.set(sessionId, (this.#queued.get(sessionId) ?? []).filter((m) => m.id !== messageId));
  }
  listQueued(sessionId: string): Message[] {
    return (this.#queued.get(sessionId) ?? []).map(clone);
  }

  putPending(rec: PendingRecord): void {
    this.#pending.set(`${rec.sessionId}|${rec.callId}`, clone(rec));
  }
  deletePending(sessionId: string, callId: string): void {
    this.#pending.delete(`${sessionId}|${callId}`);
  }
  listPending(sessionId?: string): PendingRecord[] {
    return [...this.#pending.values()].filter((p) => !sessionId || p.sessionId === sessionId).map(clone);
  }

  appendRelay(rec: RelayRecord): void {
    this.#relays.push(clone(rec));
  }
  listRelays(parentId: string): RelayRecord[] {
    return this.#relays.filter((r) => r.parentId === parentId).map(clone);
  }

  appendTrace(rec: TraceRecord): void {
    this.#traces.push(clone(rec));
  }
  listTraces(filter?: { sessionId?: string }): TraceRecord[] {
    return this.#traces.filter((t) => !filter?.sessionId || t.sessionId === filter.sessionId).map(clone);
  }

  close(): void {}
}
