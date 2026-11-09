// Storage contract. The database is the source of truth for sessions,
// messages, tool calls, pending questions, relays and traceable records.
// Synchronous on purpose: the default backend is embedded SQLite.
import type { AgentRole, Message, PendingItem, SessionStatus, TraceRecord } from '../types.ts';

export interface SessionRecord {
  id: string;
  parentId: string | null;
  role: AgentRole;
  title: string | null;
  status: SessionStatus;
  /** Serializable session configuration (provider, model, tools, cwd, ...). */
  config: SessionConfig;
  createdAt: string;
  updatedAt: string;
}

export interface SessionConfig {
  system: string;
  providerId: string;
  model: string;
  maxTokens: number;
  cwd: string;
  /** Tool allow-list; undefined = all registered tools. */
  tools?: string[];
  maxTurns: number;
  temperature?: number;
  /** Enable model-hosted web search when the provider has it. */
  serverWebSearch?: boolean;
  /** Reserved for persistent members (role template, memory, own tools). */
  templateId?: string;
  memoryId?: string;
}

/** Keyed by (sessionId, messageId, id): some gateways reuse call ids across turns. */
export interface ToolCallRecord {
  id: string;
  sessionId: string;
  messageId: string;
  name: string;
  input: unknown;
  status: 'running' | 'ok' | 'error' | 'denied' | 'pending';
  result?: string;
  startedAt: string;
  endedAt?: string;
}

/**
 * A pending confirmation or question. Results of sibling calls from the same
 * turn live in the tool-call records, so a run can resume after a restart.
 */
export interface PendingRecord {
  sessionId: string;
  callId: string;
  /** The assistant message that issued the call. */
  messageId: string;
  item: PendingItem;
}

export interface RelayRecord {
  id: string;
  parentId: string;
  childId: string;
  kind: 'user_message' | 'decision' | 'report';
  text: string;
  createdAt: string;
}

export interface Store {
  upsertSession(rec: SessionRecord): void;
  getSession(id: string): SessionRecord | undefined;
  listSessions(): SessionRecord[];

  appendMessage(msg: Message): void;
  updateMessage(msg: Message): void;
  listMessages(sessionId: string): Message[];

  upsertToolCall(rec: ToolCallRecord): void;
  /** All tool calls of a session, or only those issued by one assistant message. */
  listToolCalls(sessionId: string, messageId?: string): ToolCallRecord[];

  /** Messages waiting to be applied at the next turn boundary (steers, relay notes), in order. */
  putQueued(msg: Message): void;
  deleteQueued(sessionId: string, messageId: string): void;
  listQueued(sessionId: string): Message[];

  putPending(rec: PendingRecord): void;
  deletePending(sessionId: string, callId: string): void;
  listPending(sessionId?: string): PendingRecord[];

  appendRelay(rec: RelayRecord): void;
  listRelays(parentId: string): RelayRecord[];

  appendTrace(rec: TraceRecord): void;
  listTraces(filter?: { sessionId?: string }): TraceRecord[];

  close(): void;
}
