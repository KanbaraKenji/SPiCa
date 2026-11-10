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
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | OpaqueBlock | ImageBlock;

/**
 * An image in a user message (a pasted screenshot, a dropped picture). Only the
 * path of the copy the core keeps and its size are in the record, never the
 * pixels; it is read and sent in the provider's own format with each request.
 */
export interface ImageBlock {
  type: 'image';
  /** The core's own copy (deleted with the conversation). */
  path: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  width: number;
  height: number;
  bytes: number;
  /** File name as attached. */
  name?: string;
}

/**
 * What one attached image may be when it is sent (the strictest of the
 * providers' documented limits): longest side in pixels, file size in bytes,
 * images per message. Larger ones are made smaller (PNG) or refused.
 */
/**
 * How a key (API key, Consumer Key) is shown, the same everywhere: 24
 * characters or more give their first 4 and last 4, 12 to 23 only the last 4,
 * shorter ones nothing.
 */
export function keyMaskParts(key: string): { head: string; tail: string } {
  const k = key.trim();
  return { head: k.length >= 24 ? k.slice(0, 4) : '', tail: k.length >= 12 ? k.slice(-4) : '' };
}

/** The shown text: head + **** + tail, e.g. sk-a****3f9a, ****3f9a or ****. */
export function keyMaskText(parts: { head: string; tail: string }): string {
  return `${parts.head}****${parts.tail}`;
}

export const IMAGE_LIMITS = { maxLongSide: 1568, maxBytes: 3_750_000, maxPerMessage: 10 } as const;

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
/**
 * A change to the model settings made from outside the window (a script
 * connected to the MCP service). Never contains a key or secret. Carried by
 * the `settings.changed` event and by a note message in the conversations
 * (meta.settingsChange), so the card stays in the history.
 */
/**
 * What a conversation's context is made of, for the detail under the context
 * ring. `total` is what the provider reported for the last call (input plus the
 * answer), `measured` then true; before any call it is the estimate of what
 * the first request would carry. The parts are estimates (`estimated`), scaled
 * so that they add up to `total`. The UI words the rows from the keys.
 */
export interface ContextBreakdown {
  /** The model's context window in tokens; null when not known (no percentage then). */
  window: number | null;
  total: number;
  measured: boolean;
  parts: ContextPart[];
  /** Kept free for the answer (the model's maximum output for this conversation), counted against the window. */
  outputReserve: number;
  /** window - total - outputReserve, never below 0; null when the window is not known. */
  free: number | null;
}

export interface ContextPart {
  key: 'system' | 'tools' | 'messages';
  tokens: number;
  estimated: boolean;
  /** One level down: system.base / system.rules; messages.user / messages.assistant / messages.tool_results / messages.notes / messages.images. */
  children?: { key: string; tokens: number }[];
}

/** A connection and one of its models (the default, the strong one). */
export interface ModelPointer {
  connectionId: string;
  model: string;
}

export interface SettingsChangeMeta {
  /** add / change a connection (one address, one key, the models ticked under it), or point the default / strong model elsewhere. */
  action: 'add_connection' | 'change_connection' | 'set_default_model' | 'set_strong_model';
  /** The connection (its id in the settings). */
  id: string;
  name: string;
  kind: 'openai-compatible' | 'anthropic' | 'wso2';
  baseUrl?: string;
  tokenUrl?: string;
  /** Shown masked (keyMaskText): first and last 4 characters for long ones, the last 4 for mid-length ones, nothing else. */
  consumerKey?: string;
  scope?: string | null;
  /** add / change: the models ticked now, each with its context window and where it came from ('name-match': matched by name in the catalog). */
  /** (enabled ones only: a disabled model is named in disabledModels) */
  models?: { id: string; contextWindow: number; contextFrom: 'user' | 'catalog' | 'provider' | 'name-match' }[];
  /** add / change: models added to / removed from the connection's list by this change. */
  addedModels?: string[];
  removedModels?: string[];
  /** change: models turned on again / turned off (kept in the list, not in use) by this change. */
  enabledModels?: string[];
  disabledModels?: string[];
  /** set_default_model / set_strong_model: the model pointed at. */
  model?: string;
  /** Names of the changed fields ('new' for a new connection, 'models', 'default', 'strong', ...). */
  changes: string[];
  /** The key / Consumer Secret: newly given or kept as saved. */
  secret?: 'new' | 'unchanged';
  /** add / change: the model of this connection made the default / the strong one. */
  makeDefault?: string;
  makeStrong?: string;
  /** Where the default / strong model pointed before and after, when the change moved it (also when a pointed-at model was unticked). */
  defaultMoved?: { from: ModelPointer | null; to: ModelPointer | null };
  strongMoved?: { from: ModelPointer | null; to: ModelPointer | null };
  /** The connection test run before saving (one of the models). */
  test?: { ok: boolean; model?: string; code?: string };
  /** Who made the change. */
  by: 'mcp';
  /** Whether the user confirmed it in the window (false: applied without asking, as set up). */
  confirmed: boolean;
  /** ISO 8601 with offset. */
  at: string;
}

export interface MessageMeta {
  /** A settings change made from outside the window: render it as a card (see SettingsChangeMeta). */
  settingsChange?: SettingsChangeMeta;
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
  /** tool_results messages: what the history tools found, by call id. */
  historyCards?: Record<string, HistoryCardMeta>;
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
  /** An image: the copy the core sends (its path, size), and whether it was made smaller to fit IMAGE_LIMITS. */
  image?: { path: string; mediaType: ImageBlock['mediaType']; width: number; height: number; bytes: number; resized: boolean };
  /** Why an image was not attached: image.too_large, image.too_many, image.unreadable (the UI words it). */
  code?: 'image.too_large' | 'image.too_many' | 'image.unreadable';
}

/** An open question or confirmation the session is waiting on. */
/** Where untrusted content came from. */
export type UntrustedKind = 'mail' | 'web' | 'file' | 'mcp' | 'history';

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
/** settings_change: a script connected to Spica's MCP service asks to change the model settings (only the window can answer). */
export type GuardCause = 'untrusted_turn' | 'outside_link' | 'sensitive_file' | 'plugin_view' | 'settings_change';

/** What a plugin's own view gets back from callPluginTool (the tool's text as is). */
export interface PluginToolResult {
  content: string;
  isError: boolean;
  /** The user said no to the confirmation (nothing ran). */
  declined?: boolean;
  /** Called with confirmed: false and the tool needs the user's yes: nothing ran; `content` says why. Ask, then call again with confirmed: true. */
  needsConfirmation?: boolean;
}

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
  /** The model settings were changed from outside the window (also written as a note into the conversations). */
  | { type: 'settings.changed'; change: SettingsChangeMeta }
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
  /** What a history tool found (search_history, read_history, find_history_files), as rows. Sent before the tool's `tool.end`. */
  | { type: 'history.card'; callId: string; card: HistoryCardMeta }
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

/**
 * What one of the history tools found (event `history.card`, kept in
 * `MessageMeta.historyCards`). One row per piece, message or file; every row
 * names the conversation it is in, so a click can open it there.
 */
export interface HistoryCardMeta {
  tool: 'search_history' | 'read_history' | 'find_history_files';
  /** The words searched for (search), the part of the file name (files); absent for read. */
  query?: string;
  /** How many there were in all; `rows` may be fewer (the newest). */
  total: number;
  rows: HistoryCardRow[];
}

export interface HistoryCardRow {
  /** The short number the model sees for this row ([n]); the same place keeps its number within the asking conversation. */
  ref: number;
  sessionId: string;
  /** The conversation's name as the window shows it: its title, else its first message (first line); null when it has neither. */
  name: string | null;
  projectId?: string;
  projectName?: string;
  /** ISO 8601 with offset: when the message was written or the file came up. */
  at: string;
  /** Message number in that conversation (to scroll to it); absent when unknown. */
  seq?: number;
  /** Who wrote it (search, read). */
  who?: 'user' | 'agent' | 'other';
  /** One piece of the text (search, read), redacted, at most 300 characters; for files the path. */
  text: string;
  /** Files only: absolute or as given, and how it came up. */
  path?: string;
  how?: 'attached' | 'attached_image' | 'read' | 'written' | 'edited';
}

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
  /**
   * The address that worked when the given one answered 404: the same with /v1
   * added (code address.v1_added). The form puts it in; the saved address is
   * what conversations use, nothing is changed behind the user's back.
   */
  suggestedBaseUrl?: string;
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

/** 'settings': a setting changed from outside the window (Spica's MCP service), no external request. */
export type TraceKind = 'model' | 'search' | 'fetch' | 'mcp' | 'auth' | 'settings' | 'other';

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
  /** For a call that needed confirmation: who gave it ('user' = the confirmation card, 'view' = a plugin view that asked the user itself). */
  /** 'none' (kind settings): applied without asking the user, as the settings say. */
  confirmedBy?: 'user' | 'view' | 'none';
  /** kind 'settings': names of the fields that changed (never their values). */
  changes?: string[];
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
  /**
   * A plugin's view (its iframe) calls one of that plugin's own tools: no model, nothing in any session's history.
   * Irreversible tools (and tools a hook wants confirmed) ask the user first: confirm.request with cause 'plugin_view'
   * on `sessionId` (or the default top-level thread); answer it with confirm(sameSessionId, callId, approved).
   */
  /**
   * `confirmed`: true = the view already asked the user, run without asking again (recorded as confirmedBy 'view');
   * false = do not ask here: when a confirmation is needed, return at once with needsConfirmation; left out = ask with a
   * confirm.request card and wait.
   */
  callPluginTool?(pluginId: string, toolName: string, args: Record<string, unknown>, opts?: { sessionId?: string; confirmed?: boolean }): Promise<PluginToolResult>;
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
  /** Progress reports of the project manager nobody has looked at yet (the sidebar marks the project). */
  unread?: number;
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
  /** The project manager finished a piece of work: detail = the start of its report. */
  | 'manager.report'
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
