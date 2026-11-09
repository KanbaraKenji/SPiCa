// In-memory store (tests and ephemeral runs).
import type { Message, TraceRecord } from '../types.ts';
import type { PendingRecord, RelayRecord, SessionRecord, Store, ToolCallRecord } from './types.ts';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #messages = new Map<string, Message[]>();
  readonly #toolCalls = new Map<string, ToolCallRecord>();
  readonly #pending = new Map<string, PendingRecord>();
  readonly #relays: RelayRecord[] = [];
  readonly #traces: TraceRecord[] = [];

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
    this.#toolCalls.set(rec.id, clone(rec));
  }
  listToolCalls(sessionId: string): ToolCallRecord[] {
    return [...this.#toolCalls.values()].filter((t) => t.sessionId === sessionId).map(clone);
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
