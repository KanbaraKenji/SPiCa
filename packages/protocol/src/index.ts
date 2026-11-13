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
  /**
   * Set when a regenerated answer replaced this message: it belongs to the old answer `version` (1, 2, ...) to the
   * user message `of`. The model never sees it again; getMessages returns it only with `{ superseded: true }`.
   * Messages without it are current.
   */
  superseded?: SupersededMark;
}

/** Which old answer a replaced message belongs to (see Message.superseded). */
export interface SupersededMark {
  /** ISO 8601 with offset: when it was replaced. */
  at: string;
  /** Id of the user message the answer was to. */
  of: string;
  /** The old answer's number: 1 for the first answer, 2 for the second, ... (the current one is the highest plus 1). */
  version: number;
}

/**
 * Why an answer cannot be regenerated. Only the last round of the user's own conversations (role top, template top)
 * can be; a round that wrote files, ran a tool that is not declared read-only, or started sub-agents cannot.
 */
export type RegenerateCode =
  | 'regenerate.running'
  | 'regenerate.waiting'
  | 'regenerate.wrote_files'
  | 'regenerate.spawned'
  | 'regenerate.acted'
  | 'regenerate.not_last'
  | 'regenerate.not_typed'
  | 'regenerate.role'
  | 'regenerate.no_turn';

/** The words the UI shows for each RegenerateCode (the core puts the same text in `hint`). */
/**
 * What message_agent's result says (after the fetch-time line) when it was not sent because the conversation reached its limit of messages to
 * other agents since the user last wrote (RuntimeOptions.defaults.agentMessages). The window finds it by this.
 */
export const AGENT_MESSAGES_LIMIT_MARK = 'Not sent: message limit reached.';

/** Starts the note added for the model after the result of the same call repeated (not shown to the user). */
export const REPEAT_REMINDER_MARK = 'Note: repeated call.';
/** Starts the result of a call not run because it was the same call too many times in a row (run.end 'repeated'). */
export const REPEAT_STOP_MARK = 'Not run: repeated call.';

export const REGENERATE_HINTS: Record<RegenerateCode, string> = {
  'regenerate.running': '对话正在运行，无法重新生成。',
  'regenerate.waiting': '对话正在等待确认或回答，无法重新生成。',
  'regenerate.wrote_files': '这一轮修改过文件，无法重新生成。',
  'regenerate.spawned': '这一轮派出过子任务，无法重新生成。',
  'regenerate.acted': '这一轮调用过可能产生改动的工具，无法重新生成。',
  'regenerate.not_last': '这不是最后一轮回答，无法重新生成。',
  'regenerate.not_typed': '这一轮不是由用户消息开始的，无法重新生成。',
  'regenerate.role': '项目经理、子任务和邮件分拣的对话无法重新生成。',
  'regenerate.no_turn': '没有可以重新生成的回答。',
};

/** Whether the last round can be regenerated now (SessionInfo.regenerate). */
export interface RegenerateState {
  /** The user message the last round answers; null when there is none. The button goes under that round's last answer. */
  anchorId: string | null;
  ok: boolean;
  code?: RegenerateCode;
  /** REGENERATE_HINTS[code]: shown as is. */
  hint?: string;
}

export type RegenerateResult =
  /** Started: the old answer became `version - 1`; the new one streams in as usual. */
  | { ok: true; anchorId: string; version: number }
  | { ok: false; code: RegenerateCode; hint: string };

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
  /** Runtime note: the user chose the working folder; what was made before moved there. */
  cwdChange?: CwdChangeMeta;
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
  /** tool_results messages: every file card of a call, by call id, in order (fileCards keeps the first). */
  fileCardLists?: Record<string, FileCardMeta[]>;
  /** tool_results messages: suggestion cards produced by the calls, by call id. */
  suggestedActions?: Record<string, { title: string; actions: SuggestedAction[] }>;
  /** tool_results messages: what the history tools found, by call id. */
  historyCards?: Record<string, HistoryCardMeta>;
  /** tool_results messages: what kind of step each call was, by call id (older messages have none: go by tool name). */
  toolInfo?: Record<string, ToolCallInfo>;
  /** tool_results messages: the web pages each web_fetch / web_search call used, by call id. */
  sourceCards?: Record<string, SourceCardMeta>;
  /** tool_results messages: what remember / forget changed, by call id (the "Saved: …" line). */
  memoryCards?: Record<string, MemoryCardMeta>;
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
  /** Calls of a model without a known price were made in this session (not in costUsd; shown 「未计价」). */
  unpriced?: true;
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
  /**
   * The user can still choose a working folder for this conversation (setSessionCwd): it works in its own folder in
   * the app data because none was chosen (or, from 0.1.0-rc.2 and before, in the folder all conversations shared),
   * and it is not part of a project. Once chosen it cannot change again.
   * (A running conversation is refused with `cwd.busy`: also look at `status`.)
   */
  canChooseCwd?: boolean;
  /**
   * Whether the last round's answer can be regenerated now, and why not. Worked out when read; `session.updated`
   * is sent whenever it changes (a run starts or ends, a confirmation is asked or answered).
   */
  regenerate?: RegenerateState;
}

/** Note in the conversation: the user chose its working folder and what it had made was moved there. */
export interface CwdChangeMeta {
  from: string;
  to: string;
  /** Moved files, relative to the folders (`to` differs from `from` when renamed). */
  moved: { from: string; to: string }[];
  /** The moved files that got another name because one of the same name was already there. */
  renamed: { from: string; to: string }[];
  /**
   * Nothing was moved: the conversation worked in the folder every conversation shared in an earlier version
   * (0.1.0-rc.2 and before), and its files stay there (this folder; `moved` and `renamed` are empty).
   */
  filesStayIn?: string;
}

/**
 * What setSessionCwd did. `cwd.not_changeable`: a folder was chosen before, or it is part of a project;
 * `cwd.busy`: it (or a sub-agent under it) is running or waits for the user; `cwd.bad_folder`: not an absolute path,
 * a file, the conversation's own folder or inside it, or it cannot be made; `cwd.move_failed`: moving `file` failed,
 * everything was put back (except `notRestored`) and the working folder is unchanged.
 */
export type SetCwdResult =
  | { ok: true; info: SessionInfo; moved: { from: string; to: string }[]; renamed: { from: string; to: string }[]; filesStayIn?: string }
  | { ok: false; code: 'cwd.not_changeable' | 'cwd.busy' | 'cwd.bad_folder' | 'cwd.move_failed'; message: string; file?: string; notRestored?: string[] };

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

/**
 * `irreversible` on a confirmation: what it allows cannot be undone (a plugin hook said so, or the plugin declared
 * the tool in permissions.irreversible); the card shows 无法撤销 and the warning mark.
 */
export type PendingItem =
  | { kind: 'confirm'; callId: string; toolName: string; input: unknown; reason: string; cause?: GuardCause; irreversible?: boolean; createdAt: string }
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
  /** The same call (tool, input, result) came too many times in a row: not run, the user decides (repeatStop). */
  | 'repeated'
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
  /** regenerate: these messages (the answer to `anchorId`) are now old answer `version`; a new answer follows. */
  | { type: 'messages.superseded'; anchorId: string; messageIds: string[]; version: number }
  /** category, summary, title: what the step is, for the window's summaries (see ToolCallInfo). */
  | { type: 'tool.start'; callId: string; name: string; input: unknown; category?: ToolCategory; summary?: string; title?: string }
  /**
   * A file was read (read_file) or made by a call; render a file card. Sent before the tool's `tool.end`.
   * `files`: every card of the call, in order, when it has several (`file` is the first).
   */
  | { type: 'file.card'; callId: string; file: FileCardMeta; files?: FileCardMeta[] }
  | {
      type: 'tool.end';
      callId: string;
      name: string;
      isError: boolean;
      /** First part of the result, for collapsed views. */
      preview: string;
      durationMs: number;
    }
  /** `irreversible`: as on a pending confirmation (the card shows 无法撤销). */
  | { type: 'confirm.request'; callId: string; name: string; input: unknown; reason: string; cause?: GuardCause; irreversible?: boolean }
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
  /** web_fetch / web_search: the pages a call used (kept in tool_results meta.sourceCards by call id). */
  | { type: 'source.card'; callId: string; card: SourceCardMeta }
  /**
   * The user's memory changed: the assistant saved, replaced or forgot an item
   * (callId set, the "Saved: …" line with its undo), or the user edited,
   * deleted, restored or cleared items in the settings (no callId).
   */
  | { type: 'memory.changed'; callId?: string; card: MemoryCardMeta }
  /** A tidy of the memory started, ended or failed (on no conversation). */
  | { type: 'memory.tidy'; run: MemoryTidyRun }
  /** Tokens and estimated cost of one model call. `unpriced`: the model has no known price; costUsd is then 0 and means nothing (shown 「未计价」), it counts against no limit. */
  | { type: 'usage'; usage: Usage; costUsd: number; providerId: string; model: string; unpriced?: true }
  /** Running totals; `warning` when a total passes the warning threshold of its limit. `unpriced`: calls without a known price were made in this total and are not in spentUsd. */
  | { type: 'cost'; scope: CostScopeName; spentUsd: number; limitUsd?: number; warning: boolean; unpriced?: true }
  /** A spending limit stopped the run: the next call (up to nextUsd at worst) was not started. */
  | { type: 'budget.stop'; scope: string; spentUsd: number; limitUsd: number; nextUsd?: number; message: string }
  /** A traceable external request finished. */
  | { type: 'trace'; record: TraceRecord }
  /** One HTTP request to a model finished (every attempt, retried ones included). Sent on the call's session, or '' for none. */
  | { type: 'request'; record: RequestRecord }
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
  /** `hint`: the words for `code` (Chinese, as NET_HINTS), naming the fields as this connection's kind does (WSO2: 网关地址). */
  | { type: 'error'; message: string; retryable?: boolean; code?: string; hint?: string };

/**
 * What one of the history tools found (event `history.card`, kept in
 * `MessageMeta.historyCards`). Rows: search, one per conversation (its most
 * relevant place); read, one per message the user or an agent wrote; files,
 * one per file. Every row names the conversation it is in, so a click can
 * open it there. Only what the user typed and what agents answered shows up
 * (no runtime notes, reports or tool output), and background conversations
 * (mail sorting) are not searched.
 */
/**
 * What kind of step a tool call is, so the window can sum a group up ("Ran 4 commands, created a file, read a file")
 * without guessing from tool names. write covers new and changed files (the file card's origin tells which);
 * plugin is any tool a plugin registered.
 */
export type ToolCategory =
  | 'command'
  | 'read'
  | 'write'
  | 'web'
  | 'history'
  | 'agent'
  | 'message'
  | 'ask'
  | 'project'
  | 'mail'
  | 'present'
  | 'plugin'
  | 'other';

/** One tool call as the window sums it up (tool.start, and meta.toolInfo of the tool_results message). */
export interface ToolCallInfo {
  category: ToolCategory;
  /** What this step is for, one sentence in the user's language, written by the model (run_command's description). */
  summary?: string;
  /** The tool's name for people, when it has one (a plugin tool's MCP title). */
  title?: string;
}

/** The web pages one web_fetch or web_search call used (event source.card): a source card or footnotes. */
export interface SourceCardMeta {
  tool: 'web_fetch' | 'web_search';
  /** web_search: the words searched for. */
  query?: string;
  sources: SourceRow[];
}

export interface SourceRow {
  /** The page's address (web_fetch: where it ended up after redirects). */
  url: string;
  /** The page's title (web_fetch: from the HTML title; web_search: as the search gave it); null when there is none. */
  title: string | null;
  /** web_search: the snippet the search gave. */
  snippet?: string;
  /** web_search: the publication date the search gave, as given. */
  published?: string;
  /** ISO 8601 with offset: when it was fetched or found. */
  fetchedAt: string;
}

export interface HistoryCardMeta {
  tool: 'search_history' | 'read_history' | 'find_history_files';
  /** The words searched for (search), the part of the file name (files); absent for read. */
  query?: string;
  /** How many there are in all, counted like the rows (search: conversations); `rows` may be fewer (the newest). */
  total: number;
  rows: HistoryCardRow[];
}

/**
 * One thing the assistant remembers about the user across conversations: a
 * short sentence, with the user's own words it rests on. Kept when replaced or
 * forgotten (status), so a change can be undone; deleted in the settings, it is gone.
 */
/**
 * What a memory item is about (as Claude's memory page groups them): you = who the user is and how they want the
 * assistant to work and answer; areas = the parts of their work and life they look after (a role's duties, standing
 * rules there); topics = subjects and interests they follow; people = people they mention and how to deal with them;
 * projects = a particular project and its standing facts.
 */
export type MemoryCategory = 'you' | 'areas' | 'topics' | 'people' | 'projects';
export const MEMORY_CATEGORIES: readonly MemoryCategory[] = ['you', 'areas', 'topics', 'people', 'projects'];

export interface MemoryItem {
  /** The short number the model and the window use ([n]); never reused. */
  id: number;
  /** Whose memory it is. Only 'user' (the user themself) for now. */
  owner: string;
  text: string;
  /** What it is about; absent on items saved before there were categories, until a tidy gives them one. */
  category?: MemoryCategory;
  /** The user's words the item rests on, as typed in the conversation (redacted). */
  quote: string;
  status: 'active' | 'replaced' | 'forgotten';
  /** Forgotten by the undo on its "Saved: …" line (or by a tidy's undo, or a regenerate). */
  undone?: boolean;
  /** The tidy (MemoryTidyRun.id) that made this item, or replaced or forgot it. */
  tidyId?: number;
  /** The item this one took the place of / the item that took this one's place. */
  replaces?: number;
  replacedBy?: number;
  /** Conversation it was saved in, and the number (seq) of the user's message the quote is from; absent when added in the settings. */
  sessionId?: string;
  seq?: number;
  /** Who made the last change: the assistant (a tool call) or the user (settings). */
  by: 'assistant' | 'user';
  /** ISO 8601 with offset. */
  createdAt: string;
  updatedAt: string;
}

/**
 * One tidy of the memory: outside any conversation, the default model reads the items and what the user typed in
 * the assistant's conversations since the last tidy, and proposes changes; the runtime keeps those that pass its
 * checks. Applied at once; the whole tidy or one change can be undone.
 */
export interface MemoryTidyRun {
  id: number;
  /** auto: started when the app was idle; user: 立即整理. */
  by: 'auto' | 'user';
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  /** Conversations and messages read. */
  sessions: number;
  messages: number;
  /** The newest message read (the next tidy reads what came after it). */
  until?: string;
  changes: MemoryTidyChange[];
  /** Changes the model proposed that the checks refused (not applied). */
  refused: number;
  /** Items without a category that this tidy gave one (not changes: nothing to undo; the user can change it). */
  categorized?: number;
  costUsd?: number;
  error?: string;
}

export interface MemoryTidyChange {
  /** added: missed until now; rewritten: said differently later; merged: several items said the same; forgotten: no longer true. */
  action: 'added' | 'rewritten' | 'merged' | 'forgotten';
  /** The item made (added, rewritten, merged) or forgotten. */
  item: MemoryItem;
  /** rewritten / merged: the items it took the place of. */
  previous?: MemoryItem[];
  /** Taken back (撤销). */
  undone?: boolean;
}

/** Why an item typed in the settings was not kept: nothing typed, longer than 200 characters, or it looks like a key, password or ID number. */
export interface MemoryRefusal {
  refused: 'empty' | 'too_long' | 'secret';
}

/** What changed in the user's memory (event `memory.changed`, kept in `MessageMeta.memoryCards` when a tool did it). */
export interface MemoryCardMeta {
  action: 'saved' | 'replaced' | 'forgotten' | 'edited' | 'restored' | 'deleted' | 'cleared' | 'undone' | 'tidied';
  /** The item saved, edited, forgotten, restored or deleted (absent for cleared). */
  item?: MemoryItem;
  /** replaced: the item that was taken out. */
  previous?: MemoryItem;
  /** cleared: how many items were deleted. */
  count?: number;
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
  /** Message number in that conversation (to scroll to it; search: the most relevant place); absent when unknown. */
  seq?: number;
  /** Search only: how many other places in this conversation match too. */
  more?: number;
  /** Search only: the message numbers of every matching place, the most relevant (`seq`) first. */
  seqs?: number[];
  /** Who wrote it (search, read): the user, or an agent (its answer, or the task an agent gave a sub-agent). */
  who?: 'user' | 'agent';
  /** One piece of the text (search, read), redacted, at most 300 characters; for files the path. */
  text: string;
  /** Files only: absolute or as given, and how it came up. */
  path?: string;
  how?: 'attached' | 'attached_image' | 'read' | 'written' | 'edited';
}

/** What a file card shows about a file the agent read or a call made (event `file.card`). */
export interface FileCardMeta {
  /** Absolute path. */
  path: string;
  name: string;
  /** `other`: any other file (an archive, an image, a drawing): no preview here; it opens with the system program. */
  kind: 'pdf' | 'docx' | 'xlsx' | 'csv' | 'pptx' | 'text' | 'other';
  /**
   * How the file came about: read; created or modified by the call; produced by the call without saying
   * which (an MCP tool's resource_link). Absent means read. When not read, `read` is empty, `extractedAt`
   * is when the card was made, and the fields about the content (pages, sheets, ...) are left out.
   */
  origin?: 'read' | 'created' | 'modified' | 'produced';
  /**
   * write_file / edit_file: lines added and removed by the call (lines that occur more or fewer times than before,
   * order ignored). Absent when not counted (other calls, files over 2 MB, not text).
   */
  lines?: { added: number; removed: number };
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
  /** A model call of a model without a known price: costUsd is left out (shown 「未计价」). */
  unpriced?: true;
  status: 'ok' | 'error' | 'aborted';
  httpStatus?: number;
  attempts?: number;
  error?: string;
  /** For a call that needed confirmation: who gave it ('user' = the confirmation card, 'view' = a plugin view that asked the user itself). */
  /** 'none' (kind settings): applied without asking the user, as the settings say. */
  confirmedBy?: 'user' | 'view' | 'none';
  /** kind 'settings': names of the fields that changed (never their values). */
  changes?: string[];
  /** Stable code of the failure when there is one (NET_HINTS: gateway.rate_limited, net.timeout, ...). */
  errorCode?: string;
}

/**
 * One HTTP request to a model endpoint: every attempt of a call is its own record (a 429 retried and then
 * answered is two records). Kept in the core's database, capped (oldest dropped). Never holds headers, bodies,
 * keys or full URLs.
 */
export interface RequestRecord {
  id: string;
  /** The model call it belongs to (TraceRecord.id). */
  traceId: string;
  startedAt: string;
  /** Until the response ended (the whole stream for the attempt that answered). */
  durationMs: number;
  sessionId: string | null;
  /** Who started the call: "model" (a conversation), "runtime:memory-tidy", "plugin:<id>", "probe". */
  initiator: string;
  providerId?: string;
  model?: string;
  /** 1 for the first attempt of the call, 2 for the first retry, ... */
  attempt: number;
  /** Another attempt followed this one. */
  retried?: true;
  status: 'ok' | 'error' | 'aborted';
  httpStatus?: number;
  /** Stable code of the failure (gateway.rate_limited, gateway.server, net.timeout, gateway.stream_idle, ...). */
  errorCode?: string;
  /** Short and with secrets removed. */
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  unpriced?: true;
}

/** The request log summed up for the usage page: one row per time bucket, provider and model. */
export interface UsageRow {
  /** Start of the bucket (ISO, UTC). */
  bucket: string;
  providerId: string;
  model: string;
  requests: number;
  ok: number;
  /** Failed or stopped, 429 answers not included (they are in rateLimited). */
  failed: number;
  /** HTTP 429 answers. */
  rateLimited: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Requests of a model without a known price were made in it (not in costUsd). */
  unpriced?: true;
  /** How many of them (0 when none). */
  unpricedRequests?: number;
}

export interface UsageQuery {
  /** Inclusive range, ISO 8601. */
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  /** Minutes east of UTC that day buckets start at (the window's time zone; 480 for UTC+8). */
  tzOffsetMinutes?: number;
}

export interface UsageSummary {
  /** When the request log starts (its oldest record), null when it is empty: no data before it. */
  since: string | null;
  query: UsageQuery;
  rows: UsageRow[];
  /** The 429 answers in the range, newest first (at most 200). */
  rateLimited: RequestRecord[];
  /** Names for the provider ids in it, when the one asking knows them (the desktop app: its connections' names). */
  providerNames?: Record<string, string>;
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
  /** Current messages; with `superseded: true` also the replaced ones (Message.superseded), all in seq order. */
  getMessages(sessionId: string, opts?: { superseded?: boolean }): Promise<Message[]>;
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
  /**
   * Choose the working folder of a conversation that has none yet (`canChooseCwd`), once: the files it made in its
   * own folder move there (all or nothing; same names get " (1)" and so on, nothing is overwritten), its sub-agents
   * work there too, a note tells the model, then `session.updated`. Refused while it runs or waits for the user.
   */
  setSessionCwd?(sessionId: string, folder: string): Promise<SetCwdResult>;
  /** Continue a session left `interrupted` (e.g. after a restart). */
  resume(sessionId: string): Promise<void>;
  /**
   * Answer the last user message again: the round's messages are marked as an old answer (messages.superseded), the
   * model no longer sees them, and a new run starts with the session's model and approval mode as they are now.
   * `messageId`: the answer the user clicked; refused with `regenerate.not_last` when it is not in the last round.
   * Returns at once; refused (nothing changed) when SessionInfo.regenerate is not ok.
   */
  regenerate?(sessionId: string, messageId?: string): Promise<RegenerateResult>;
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
   * Delete a conversation and the sub-agents under it from Spica: their messages, tool calls, pending items and the
   * copies of attached images. Files they made (in their working folder) stay. Running ones are stopped first; then
   * `session.deleted` for each. A project manager cannot be deleted on its own (delete the project). Traceable records stay.
   */
  deleteSession?(sessionId: string): Promise<void>;
  // The user's memory (the assistant's conversations; see docs/design/memory.md). Every change sends memory.changed.
  /** Active items oldest first; with `all` also the replaced and forgotten ones (to tell an undone "Saved: …" line). */
  listMemories?(opts?: { all?: boolean }): Promise<MemoryItem[]>;
  /** The user adds an item in the settings (no quote; secrets refused), in a category or none. */
  addMemory?(text: string, category?: MemoryCategory): Promise<MemoryCardMeta | MemoryRefusal>;
  /** Change the sentence (and with `category`, the category) of an active item; undefined when it is gone. */
  editMemory?(id: number, text: string, category?: MemoryCategory): Promise<MemoryCardMeta | MemoryRefusal | undefined>;
  /** Delete an item for good, with the older versions it replaced; undefined when it is not active. */
  forgetMemory?(id: number): Promise<MemoryCardMeta | undefined>;
  /** Delete every active item for good (as forgetMemory); how many. */
  clearMemories?(): Promise<number>;
  /** The undo on a "Saved: …" line: a save is taken back, a replacement gives way to the old item, a forgotten item returns. */
  undoMemory?(id: number): Promise<MemoryCardMeta | undefined>;
  /** 立即整理: starts a tidy and returns at once (memory.tidy events follow); refused while one runs, memory is off or no model is set. */
  tidyMemories?(): Promise<{ started: true; id: number } | { started: false; reason: 'running' | 'off' | 'no_model' }>;
  /** The latest tidies, newest first. */
  listMemoryTidies?(limit?: number): Promise<MemoryTidyRun[]>;
  /** 撤销 a whole tidy, or one of its changes (index in changes); what still stands is taken back. */
  undoMemoryTidy?(id: number, change?: number): Promise<MemoryTidyRun | undefined>;
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
