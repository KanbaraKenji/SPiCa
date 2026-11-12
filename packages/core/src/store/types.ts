// Storage contract. The database is the source of truth for sessions,
// messages, tool calls, pending questions, relays and traceable records.
// Synchronous on purpose: the default backend is embedded SQLite.
import type { AgentRole, MailItem, MemoryItem, MemoryTidyRun, Message, PendingItem, ProjectInfo, ProjectLogEntry, SessionStatus, SupersededMark, TraceRecord, WorkObject } from '../types.ts';

export type SenderDecision = { decision: 'project'; projectId: string } | { decision: 'ignore' };

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
  /**
   * The turn limit when the session was made. It applies only when the creator asked for it (`asked` has
   * 'maxTurns'); otherwise each run takes the runtime's default as it is then (RuntimeOptions.defaults.maxTurns).
   * Records written before 2026-11-12 never have `asked`: they follow the default too (nothing asked for a limit
   * of its own then, except tests).
   */
  maxTurns: number;
  /** Limits the creator asked for itself (CreateSessionRequest), kept as given; the others follow the runtime. */
  asked?: ('maxTurns' | 'maxTokens')[];
  /** Interface language (BCP 47), used until the user writes. */
  locale?: string;
  temperature?: number;
  /** Enable model-hosted web search when the provider has it. */
  serverWebSearch?: boolean;
  /** Role template the session was created from. */
  templateId?: string;
  /** Project the session works for (manager and its sub-agents). */
  projectId?: string;
  /** Default manual. */
  approvalMode?: import('../types.ts').ApprovalMode;
  memoryId?: string;
}

export interface ToolCallCards {
  fileCard?: import('../types.ts').FileCardMeta;
  /** Every file card of the call, in order, when it has several (fileCard is the first). */
  fileCards?: import('../types.ts').FileCardMeta[];
  suggestion?: { title: string; actions: import('../types.ts').SuggestedAction[] };
  /** What a history tool found (rows with their [n] numbers). */
  history?: import('../types.ts').HistoryCardMeta;
  /** The web pages a web_fetch / web_search call used. */
  sources?: import('../types.ts').SourceCardMeta;
  /** Images the call returned (kept copies), sent to the model after the results. */
  images?: import('../types.ts').ImageBlock[];
  /** The result was outside content and went to the model fenced as data. */
  guard?: import('../types.ts').GuardNote;
  /** Ran without asking (approval mode auto). */
  autoApproved?: true;
  /** What remember / forget changed in the user's memory. */
  memory?: import('../types.ts').MemoryCardMeta;
}

/** Keyed by (sessionId, messageId, id): some gateways reuse call ids across turns. */
export interface ToolCallRecord {
  id: string;
  sessionId: string;
  messageId: string;
  name: string;
  input: unknown;
  /** `unavailable`: the model called a tool that does not exist (any more); nothing ran. */
  status: 'running' | 'ok' | 'error' | 'denied' | 'pending' | 'unavailable';
  result?: string;
  /** Cards the call produced (file card, suggestions), copied into the tool_results message. */
  cards?: ToolCallCards;
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
  /** Remove a session and what belongs to it: messages, tool calls, queued and pending items, relays it is part of. Traceable records stay (spending history). */
  deleteSession(id: string): void;

  appendMessage(msg: Message): void;
  updateMessage(msg: Message): void;
  /** Every message of the session in seq order, replaced ones (Message.superseded) included. */
  listMessages(sessionId: string): Message[];
  /** Mark these messages of the session as old answer `mark.version` (all or none); ids of other sessions are ignored. */
  supersedeMessages(sessionId: string, ids: readonly string[], mark: SupersededMark): void;

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

  upsertProject(p: ProjectInfo): void;
  /** Remove a project, its activity log, its work objects and the sender memory that points at it. */
  deleteProject(id: string): void;
  getProject(id: string): ProjectInfo | undefined;
  listProjects(): ProjectInfo[];
  appendProjectLog(e: ProjectLogEntry): void;
  /** Newest first. */
  listProjectLog(projectId: string, limit?: number): ProjectLogEntry[];
  upsertWorkObject(o: WorkObject): void;
  listWorkObjects(projectId: string): WorkObject[];

  upsertMail(m: MailItem): void;
  getMail(id: string): MailItem | undefined;
  /** Oldest first. */
  listMail(filter?: { status?: MailItem['status']; projectId?: string; limit?: number }): MailItem[];
  /** Sender memory: what the user did with this sender's mail (put it in a project, or ignored it). */
  setSenderDecision(address: string, d: SenderDecision): void;
  getSenderDecision(address: string): SenderDecision | undefined;

  /** The user's memory across conversations. `id` 0 means a new item: the store gives the next number and returns it. */
  putMemory(m: MemoryItem): MemoryItem;
  getMemory(id: number): MemoryItem | undefined;
  /** Oldest first; only the active ones unless `all`. */
  listMemories(owner: string, opts?: { all?: boolean }): MemoryItem[];
  /** Tidies of the memory. `id` 0 means a new one (numbered by the store). */
  putMemoryTidy(t: MemoryTidyRun): MemoryTidyRun;
  getMemoryTidy(id: number): MemoryTidyRun | undefined;
  /** Newest first. */
  listMemoryTidies(limit?: number): MemoryTidyRun[];
  /** Where the next tidy starts reading (ISO time), per owner; kept across restarts. */
  getMemoryCursor(owner: string): string | undefined;
  setMemoryCursor(owner: string, at: string): void;

  appendTrace(rec: TraceRecord): void;
  listTraces(filter?: { sessionId?: string }): TraceRecord[];

  close(): void;
}
