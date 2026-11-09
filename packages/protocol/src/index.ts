// Type definitions for Spica's backend API and events.
// Every feature is a backend API first; the desktop UI and the MCP server
// are both clients of these contracts.
//
// This file must stay dependency-free and runtime-agnostic (it is used by the
// Electron main process, the renderer and the agent core). Keep it a single
// file with no relative imports.

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

/** Basic information about the running application. */
export interface AppInfo {
  /** Display name of the app (user-customizable later; defaults to "Spica"). */
  name: string;
  /** Semantic version of the desktop app. */
  version: string;
}

/** API exposed to the renderer through the preload bridge (`window.spica`). */
export interface SpicaBridge {
  getAppInfo(): Promise<AppInfo>;
}

/** IPC channel names shared by main and preload. */
export const IpcChannel = {
  AppInfo: 'spica:app-info',
} as const;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** A piece of message content. Spica's own format, not any vendor's wire format. */
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | OpaqueBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  /** Opaque provider data that must be echoed back unchanged (e.g. a signature). */
  signature?: string;
  /** Provider id that produced the block; other providers drop it when serializing. */
  provider?: string;
  redacted?: boolean;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  /** Result text as the model saw it (first line is the fetch time). */
  content: string;
  isError?: boolean;
}

/**
 * A vendor-specific block carried verbatim (e.g. results of a model-hosted
 * tool). It is echoed back only to the provider that produced it; other
 * providers see `text` instead, or nothing. UIs should render `text`.
 */
export interface OpaqueBlock {
  type: 'opaque';
  provider: string;
  data: unknown;
  text?: string;
}

/**
 * Why a message exists. `user` and `assistant` are real turns; the others are
 * written by the runtime and shown to the model as labelled user-side notes.
 */
export type MessageKind =
  | 'user' // the task or a message typed into this session
  | 'assistant' // produced by the model
  | 'tool_results' // results of tool calls
  | 'steer' // user message inserted while a run was in progress
  | 'relay' // note relayed from a child session (what the user said / decided there)
  | 'report' // a child session's final report, delivered to its parent
  | 'note'; // other runtime note

/** Who wrote a user-side message. */
export type Author = 'user' | 'parent' | 'child' | 'runtime' | 'plugin';

/**
 * Structured metadata on notes that come from a child session (message kinds
 * `relay` and `report`). The message text is written for the model; UIs
 * should render from these fields instead of parsing the text.
 */
export interface ChildNoteMeta {
  author: 'child';
  /** report = the child's final answer; relay = what the user wrote there; decision = a decision made or changed there. */
  kind: 'report' | 'relay' | 'decision';
  fromSessionId: string;
  fromTitle: string | null;
  /** When it happened in the child (ISO 8601 with offset). */
  at: string;
  /** The original words: the user's message, the decision, or the report. */
  text: string;
  /** For decisions: recorded by the user directly or by the agent. */
  by?: 'user' | 'agent';
}

export interface Message {
  id: string;
  sessionId: string;
  /** Monotonic position inside the session. */
  seq: number;
  role: 'user' | 'assistant';
  kind: MessageKind;
  content: ContentBlock[];
  /** ISO 8601 with offset. */
  createdAt: string;
  /** Assistant only: opaque per-provider fields to echo back on later turns. */
  providerExtras?: Record<string, unknown>;
  /** Metadata; see MessageMeta. Relay / report notes carry ChildNoteMeta fields. */
  meta?: MessageMeta;
}

/** Known metadata keys on messages. Everything a UI shows must be rebuildable from history. */
export interface MessageMeta {
  /** Runtime note: tools the session used before that are gone now (names). */
  toolsUnavailable?: string[];
  /** The message carries outside content (e.g. forwarded mail), fenced as data. */
  untrusted?: GuardNote[];
  /** tool_results: outside content per tool call id. */
  guard?: Record<string, GuardNote>;
  /** User message: attached files (the cards); their text is in the content blocks listed. */
  attachments?: AttachmentMeta[];
  /** tool_results: calls that ran without asking because the session's approval mode is auto. */
  autoApproved?: string[];
  /** Runtime note: the user switched the session's model (a decision). */
  modelChange?: { from: { providerId: string; model: string }; to: { providerId: string; model: string } };
  /** One of Author; typed loosely so older callers that build plain objects still compile. */
  author?: Author | (string & {});
  /** Assistant text saved while it was streaming. */
  partial?: boolean;
  /** The stream was cut (user interrupt, error or app crash): show as interrupted. */
  interrupted?: boolean;
  error?: boolean;
  model?: string;
  stopReason?: StopReason;
  /** tool_results messages: file cards produced by the calls, by call id. */
  fileCards?: Record<string, FileCardMeta>;
  /** tool_results messages: suggestion cards produced by the calls, by call id. */
  suggestedActions?: Record<string, { title: string; actions: SuggestedAction[] }>;
  [key: string]: unknown;
}

/** JSON schema for tool input (kept loose on purpose). */
export type JsonSchema = Record<string, unknown>;

/** What the model sees about a tool. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause' | 'other';

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Place in the team: top-level agent, project manager, or sub-agent. */
export type AgentRole = 'top' | 'manager' | 'worker';

export type SessionStatus =
  | 'idle' // nothing running, ready for input
  | 'queued' // waiting for a rate-limit slot
  | 'thinking' // model request in flight
  | 'tool' // running tools
  | 'awaiting_confirm' // an irreversible action needs the user's approval
  | 'awaiting_answer' // ask_user card waiting for the user's answer
  | 'done' // a one-off sub-agent finished and reported
  | 'error'
  | 'aborted'
  | 'interrupted'; // the app stopped mid-run; can be resumed

export interface SessionInfo {
  id: string;
  parentId: string | null;
  /** Ancestors, nearest parent first. */
  parentChain: string[];
  role: AgentRole;
  /** Display name; null until someone names it (the UI decides what to show). */
  title: string | null;
  status: SessionStatus;
  providerId: string;
  model: string;
  /** Working folder for file tools. */
  cwd: string;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  /** Role template the session was created from (e.g. 'top', 'project-manager'). */
  templateId?: string;
  /** Project the session works for (project manager and its sub-agents). */
  projectId?: string;
  // The three below are always set by the core (optional only so older fakes still type-check).
  /** manual = every confirmation goes to the user; auto = tools that are irreversible by declaration run and are recorded. */
  approvalMode?: ApprovalMode;
  /** Tokens the context takes now (from the last model call: its input plus its output), null before the first call. */
  contextTokens?: number | null;
  /** Context window of the session's model, null when unknown. */
  contextWindow?: number | null;
}

/**
 * auto: confirmations a tool asks for because it is irreversible pass on their own (recorded, event confirm.auto).
 * Confirmations the guard requires (untrusted_turn, outside_link, sensitive_file) and those a hook asks for always
 * go to the user.
 */
export type ApprovalMode = 'manual' | 'auto';

/** A file the user attached to a message; its content went to the model fenced as data. */
export interface AttachmentMeta {
  /** As given (absolute, or relative to the session's working folder). */
  path: string;
  /** File name for the card. */
  name: string;
  /** Index of the content block that carries the file text (the UI hides it), null when it could not be read. */
  block: number | null;
  /** Same card read_file makes (type, size, pages read, truncated, ...). */
  file?: FileCardMeta;
  /** Why it could not be read (English, for logs). */
  error?: string;
}

/** An open question or confirmation the session is waiting on. */
/** Where untrusted content came from. */
export type UntrustedKind = 'mail' | 'web' | 'file' | 'mcp';

/** What the guard noticed in one piece of outside content. */
export interface GuardNote {
  kind: UntrustedKind;
  /** Tool name or mail id it came from. */
  source: string;
  /** Instruction-like patterns found: override, role, address_agent, exfiltrate, secret_file, run_command, mail_action. */
  signals: string[];
}

/**
 * Why the guard asked for confirmation: untrusted_turn = an irreversible action after outside content (even when a
 * plugin set it to automatic); outside_link = opening a link that came from outside content; sensitive_file = reading a
 * credential file after outside content.
 */
export type GuardCause = 'untrusted_turn' | 'outside_link' | 'sensitive_file';

export type PendingItem =
  | { kind: 'confirm'; callId: string; toolName: string; input: unknown; reason: string; cause?: GuardCause; createdAt: string }
  | { kind: 'ask'; callId: string; question: string; options?: string[]; createdAt: string };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventBase {
  /** Global monotonic sequence number (for replay after reconnect). */
  seq: number;
  /** ISO 8601 timestamp with offset. */
  at: string;
  sessionId: string;
  /** Ancestor session ids, nearest parent first. */
  parentChain: string[];
}

export type RunEndReason =
  | 'completed'
  | 'max_turns'
  | 'budget'
  | 'aborted'
  | 'error'
  | 'awaiting_confirm'
  | 'awaiting_answer';

export type CostScopeName = 'call' | 'run' | 'session' | 'global';

export type CoreEventBody =
  /** Session state changed. */
  | { type: 'status'; status: SessionStatus; detail?: string }
  /** Waiting for a rate-limit slot; position is 1-based. */
  | { type: 'queue'; position: number; waitingFor: string }
  /** Streaming answer text. */
  | { type: 'text.delta'; delta: string }
  /** Streaming reasoning text (when the model exposes it). */
  | { type: 'thinking.delta'; delta: string }
  /** A model has started writing a tool call (arguments still streaming). */
  | { type: 'tool.call'; callId: string; name: string }
  /** A complete message was appended to the session. */
  | { type: 'message'; message: Message }
  /** A plugin hook changed a message after it had been streamed. */
  | { type: 'message.replaced'; messageId: string; content: ContentBlock[] }
  | { type: 'tool.start'; callId: string; name: string; input: unknown }
  /** A file was read (read_file); render a file card. Sent before the tool's `tool.end`. */
  | { type: 'file.card'; callId: string; file: FileCardMeta }
  | {
      type: 'tool.end';
      callId: string;
      name: string;
      isError: boolean;
      /** First part of the result, for collapsed views. */
      preview: string;
      durationMs: number;
    }
  | { type: 'confirm.request'; callId: string; name: string; input: unknown; reason: string; cause?: GuardCause }
  /** Outside content (mail, web page, file, plugin tool) contained text that looks like instructions. */
  | { type: 'guard.flagged'; note: GuardNote; callId?: string }
  /** An irreversible call ran without asking because the session's approval mode is auto. */
  | { type: 'confirm.auto'; callId: string; name: string; input: unknown }
  /** Session details changed (context use after a model call, model, approval mode). */
  | { type: 'session.updated'; info: SessionInfo }
  | { type: 'confirm.resolved'; callId: string; approved: boolean }
  | { type: 'ask.request'; callId: string; question: string; options?: string[] }
  | { type: 'ask.resolved'; callId: string; answer: string }
  /**
   * Suggested next steps shown as a card (suggest_actions tool). The run does
   * not wait; clicking an action sends its `prompt` as a user message.
   */
  | { type: 'suggest.actions'; callId: string; title: string; actions: SuggestedAction[] }
  /** Tokens and estimated cost of one model call. */
  | { type: 'usage'; usage: Usage; costUsd: number; providerId: string; model: string }
  /** Running totals; `warning` when a total passes the warning threshold of its limit. */
  | { type: 'cost'; scope: CostScopeName; spentUsd: number; limitUsd?: number; warning: boolean }
  /** A spending limit stopped the run. */
  | { type: 'budget.stop'; scope: string; spentUsd: number; limitUsd: number; message: string }
  /** A traceable external request finished. */
  | { type: 'trace'; record: TraceRecord }
  | { type: 'steer.queued'; messageId: string; mode: SteerMode }
  | { type: 'steer.applied'; messageIds: string[] }
  | { type: 'child.spawned'; childId: string; title: string | null }
  /** Emitted on the top-level session. */
  | { type: 'project.created'; project: ProjectInfo }
  | { type: 'project.updated'; project: ProjectInfo }
  /** The project's records were removed from Spica (its folder and files were not touched). Emitted on the top-level session. */
  | { type: 'project.deleted'; projectId: string }
  /** A session was removed (with its project). Emitted with the removed session's id. */
  | { type: 'session.deleted' }
  /** A key action inside a project (emitted on the session that did it). */
  | { type: 'project.activity'; entry: ProjectLogEntry }
  /** Mail pipeline (emitted on the mail triage thread). */
  | { type: 'mail.polled'; sourceId: string; fetched: number; added: number }
  | { type: 'mail.triaged'; item: MailItem }
  | { type: 'mail.routed'; item: MailItem; managerSessionId: string }
  | { type: 'mail.feedback'; item: MailItem }
  /** Mail settings changed while running. `running` = polling on its interval. */
  | { type: 'mail.configured'; settings: MailSettings; running: boolean }
  /** Runtime settings changed while running (which groups: providers, defaults, limits, budget, workflows, locale, search, mail). */
  | { type: 'runtime.configured'; changed: string[]; warnings: string[] }
  | { type: 'session.renamed'; title: string | null }
  | { type: 'child.report'; childId: string; summary: string }
  /** A note from a child session was added to this (parent) session. */
  | { type: 'relay'; fromSessionId: string; note: string }
  /** One model call + its tool calls. */
  | { type: 'turn.start'; turn: number }
  | { type: 'turn.end'; turn: number }
  /** A run (from an input until the agent stops) ended. */
  | { type: 'run.end'; reason: RunEndReason; detail?: string }
  /** `code`: stable id of the cause (net.*, tls.*, proxy.*, gateway.*, wso2.*); the UI words it. */
  | { type: 'error'; message: string; retryable?: boolean; code?: string };

/** What a file card shows about a file the agent read (event `file.card`). */
export interface FileCardMeta {
  /** Absolute path. */
  path: string;
  name: string;
  kind: 'pdf' | 'docx' | 'xlsx' | 'csv' | 'pptx' | 'text';
  sizeBytes: number;
  /** ISO 8601 with offset. */
  modifiedAt: string;
  extractedAt: string;
  pageCount?: number;
  sheets?: { name: string; rows: number; cols: number }[];
  slideCount?: number;
  /** Which part was read. `rows` like "1-200", `range` like "A1:F40". */
  read: { pages?: string; sheet?: string; rows?: string; range?: string };
  truncated?: boolean;
  /** PDF without a text layer (scanned). */
  noTextLayer?: boolean;
  /** Detected text encoding (e.g. UTF-8, GBK). */
  encoding?: string;
}

/** Result of a "test connection" probe (one minimal request outside any session). */
export interface ProbeResult {
  ok: boolean;
  /** Whole request, in milliseconds. */
  latencyMs: number;
  /** Until the first streamed event (successful probes). */
  firstByteMs?: number;
  /** Model name the server reported. */
  model?: string;
  /** Failure category; UIs write their own message from it. */
  errorCode?: 'auth' | 'not_found' | 'rate_limited' | 'server' | 'bad_request' | 'network' | 'timeout' | 'aborted';
  /** Which step failed: getting a token (WSO2) or calling the model. */
  stage?: 'token' | 'model';
  /** Finer cause: net.* / tls.* / proxy.* / gateway.* / wso2.* (see the core's NET_HINTS). */
  code?: string;
  /** The cause in Chinese, ready to show next to "test connection". */
  hint?: string;
  httpStatus?: number;
  /** Technical detail (redacted), for logs and "show details". */
  message?: string;
}

export interface SuggestedAction {
  label: string;
  /** Sent as the user's message when the action is clicked. */
  prompt: string;
}

export type CoreEvent = EventBase & CoreEventBody;
export type CoreEventType = CoreEvent['type'];

// ---------------------------------------------------------------------------
// Traceable records
// ---------------------------------------------------------------------------

export type TraceKind = 'model' | 'search' | 'fetch' | 'mcp' | 'auth' | 'other';

/**
 * One external request (model, search, web fetch, MCP, token endpoint).
 * Never contains request headers, bodies, keys or full URLs.
 */
/** Which part of the usage log to export. All fields optional. */
export interface UsageLogFilter {
  /** Only this project: its manager, every session under it, its activity and mail. */
  projectId?: string;
  /** Inclusive range, ISO 8601 (any offset). */
  from?: string;
  to?: string;
}

export interface TraceRecord {
  id: string;
  kind: TraceKind;
  startedAt: string;
  durationMs: number;
  sessionId: string | null;
  parentChain: string[];
  /** Who started it: "model", "tool:web_fetch", "plugin:<id>", "runtime". */
  initiator: string;
  providerId?: string;
  /** Host name only. */
  target: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  bytes?: number;
  costUsd?: number;
  status: 'ok' | 'error' | 'aborted';
  httpStatus?: number;
  attempts?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Commands (the backend API; the MCP server and the UI both call these)
// ---------------------------------------------------------------------------

export type SteerMode = 'next' | 'interrupt';

export interface SendOptions {
  attachments?: { path: string }[];
}

export interface CreateSessionRequest {
  parentId?: string;
  role?: AgentRole;
  title?: string;
  /** System prompt; a default is used when omitted. */
  system?: string;
  providerId?: string;
  model?: string;
  maxTokens?: number;
  cwd?: string;
  /** Allow-list of tool names; all registered tools when omitted. */
  tools?: string[];
  maxTurns?: number;
  /** Interface language (BCP 47) the agent uses until the user writes; default zh-CN. */
  locale?: string;
  /** Apply a role template (system prompt, tools, model). Explicit fields win. */
  templateId?: string;
  /** Attach the session to a project (sub-agents inherit their parent's project). */
  projectId?: string;
  /** Default manual; sub-agents inherit their parent's. */
  approvalMode?: ApprovalMode;
}

export interface SendResult {
  messageId: string;
  /** True when the message started a run; false when it was queued into a running one. */
  started: boolean;
}

export interface AgentApi {
  createSession(req: CreateSessionRequest): Promise<SessionInfo>;
  listSessions(): Promise<SessionInfo[]>;
  getSession(sessionId: string): Promise<SessionInfo | undefined>;
  getMessages(sessionId: string): Promise<Message[]>;
  getPending(sessionId: string): Promise<PendingItem[]>;
  /** User message. Starts a run if idle; otherwise applied at the next turn boundary. */
  /** `attachments`: files on this machine; read like read_file and sent to the model fenced as data. */
  send(sessionId: string, text: string, opts?: SendOptions): Promise<SendResult>;
  /** Insert a message into a running session; `interrupt` cuts the current model stream first. */
  steer(sessionId: string, text: string, mode: SteerMode): Promise<SendResult>;
  answer(sessionId: string, callId: string, answer: string): Promise<void>;
  /** Set or clear the display name. */
  renameSession(sessionId: string, title: string | null): Promise<SessionInfo>;
  /** Use another model from the next model call on (the one running now is not touched); recorded as a decision. */
  setSessionModel?(sessionId: string, providerId: string, model: string): Promise<SessionInfo>;
  setApprovalMode?(sessionId: string, mode: ApprovalMode): Promise<SessionInfo>;
  /** Continue a session left `interrupted` (e.g. after a restart). */
  resume(sessionId: string): Promise<void>;
  confirm(sessionId: string, callId: string, approved: boolean): Promise<void>;
  abort(sessionId: string): Promise<void>;
  /** Traceable records as JSON Lines. */
  exportTraces(filter?: { sessionId?: string }): Promise<string>;
  // Project commands (M4, in progress): optional until the core implements them.
  /** The top-level agent session (created on first call). */
  getTopSession?(): Promise<SessionInfo>;
  createProject?(req: CreateProjectRequest): Promise<ProjectInfo>;
  listProjects?(): Promise<ProjectInfo[]>;
  getProject?(projectId: string): Promise<ProjectDetail | undefined>;
  /** Rename a project; its manager session takes the same title. */
  renameProject?(projectId: string, name: string): Promise<ProjectInfo>;
  /**
   * Remove a project from Spica: the project, its manager and every session under it, its activity log and work
   * objects. The project folder and its files are not touched. Running sessions are stopped first. Mail filed under it
   * becomes a "new matter" again and the sender memory that pointed at it is forgotten. Traceable records stay.
   */
  deleteProject?(projectId: string): Promise<void>;
  // Mail pipeline (M6): optional until the desktop shell implements them.
  listMail?(filter?: { status?: MailItem['status']; projectId?: string; limit?: number }): Promise<MailItem[]>;
  /** Fetch and triage now (otherwise it runs on its interval). */
  pollMail?(): Promise<MailPollResult>;
  /** The user's handling of a triaged mail; teaches the sender memory. */
  mailFeedback?(mailId: string, feedback: { action: MailFeedback['action']; projectId?: string }): Promise<MailItem>;
}

// ---------------------------------------------------------------------------
// Mail pipeline: incoming mail sorted into projects
// ---------------------------------------------------------------------------

export interface MailTriage {
  /** project = belongs to a project; new = a new matter (maybe a new project); ignore = nothing to do. */
  decision: 'project' | 'new' | 'ignore';
  projectId?: string;
  /** For `new`: what the agent suggests (e.g. a project name). */
  suggestion?: string;
  reason: string;
  /** 0..1 */
  confidence: number;
  /**
   * model = the triage agent decided; sender_memory = the user handled mail from
   * this sender before (assigned or ignored); rule = a configured ignore rule.
   */
  by: 'model' | 'sender_memory' | 'rule';
  at: string;
}

export interface MailFeedback {
  action: 'accept' | 'ignore' | 'reassign';
  projectId?: string;
  at: string;
}

export interface MailItem {
  /** `<sourceId>:<messageId>` */
  id: string;
  sourceId: string;
  messageId: string;
  fromName?: string;
  fromAddress?: string;
  subject: string;
  receivedAt?: string;
  preview?: string;
  status: 'new' | 'triaged' | 'routed' | 'ignored';
  triage?: MailTriage;
  feedback?: MailFeedback;
  /** Project-manager session it was sent to. */
  routedTo?: string;
  createdAt: string;
  updatedAt: string;
}

/** Mail settings the settings page can change while running. */
export interface MailSettings {
  /** Default off: the user turns mail on in the settings (the page says mail content goes to `triageModel`). */
  enabled?: boolean;
  /** Read only (in mail.configured / mailSettings()): the provider and model that receive mail content for sorting. */
  triageModel?: { providerId: string; model: string };
  intervalMinutes?: number;
  batchSize?: number;
  triageTemplateId?: string;
  rules?: string;
  ignore?: { from?: string[]; subject?: string[] };
}

export interface MailPollResult {
  fetched: number;
  added: number;
  triaged: number;
  routed: number;
}

// ---------------------------------------------------------------------------
// Projects (project = a folder + a persistent project-manager session)
// ---------------------------------------------------------------------------

/** A workflow file: stages and work-object levels. Swapping files adapts Spica to another team. */
export interface WorkflowDef {
  id: string;
  name: string;
  stages: { id: string; name: string; goal?: string; exitCriteria?: string[] }[];
  /** Work-object levels; `parent` names the level above (any depth). */
  objectLevels?: { id: string; name: string; parent?: string }[];
}

export interface ProjectInfo {
  id: string;
  name: string;
  /** Absolute path of the project folder. */
  folder: string;
  managerSessionId: string;
  workflowId: string | null;
  /** Current stage id (null when the project has no workflow). */
  stage: string | null;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface WorkObject {
  id: string;
  projectId: string;
  level: string;
  name: string;
  parentId: string | null;
  data?: Record<string, unknown>;
  createdAt: string;
}

/** A key action inside a project, kept for the top-level agent (system-level record). */
export type ProjectActivityKind =
  | 'file.write'
  | 'file.edit'
  | 'file.delete'
  | 'command'
  | 'child.spawn'
  | 'child.report'
  | 'decision'
  | 'stage'
  /** Incoming mail routed to the project: target = subject, detail = `<source>:<message id>`. */
  | 'mail'
  | 'note';

export interface ProjectLogEntry {
  id: string;
  projectId: string;
  /** Session that did it. */
  sessionId: string;
  at: string;
  /** What happened. UIs build their own (localized) text from action + target + detail. */
  action: ProjectActivityKind;
  /** File path relative to the project folder, a command line, a sub-agent's title, or a stage id. */
  target?: string;
  /** Extra information: a sub-agent id, the first part of a report, a stage note, a decision. */
  detail?: string;
  /** English one-liner written for the model (list_projects, open_project); do not show it as UI text. */
  summary: string;
}

export interface ProjectDetail extends ProjectInfo {
  workflow: WorkflowDef | null;
  objects: WorkObject[];
  /** Newest first. */
  recentLog: ProjectLogEntry[];
  manager: SessionInfo;
  /** Sub-agents of the manager. */
  agents: SessionInfo[];
}

export interface CreateProjectRequest {
  name: string;
  /** Absolute, or relative to the deployment's projects folder. Created if missing. Default: the name. */
  folder?: string;
  workflowId?: string;
  /** First task for the project manager. */
  brief?: string;
}
