// In-memory store (tests and ephemeral runs).
import type { Message, ProjectInfo, ProjectLogEntry, TraceRecord, WorkObject } from '../types.ts';
import type { PendingRecord, RelayRecord, SessionRecord, Store, ToolCallRecord } from './types.ts';

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

  upsertProject(p: ProjectInfo): void {
    this.#projects.set(p.id, clone(p));
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
