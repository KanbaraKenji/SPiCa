// Turns a session's history (Message[] + pending items) and its live event
// stream into what the conversation view draws. Pure functions, no React.
import { relocate, shownPath } from './relocate';
import type { CoreEvent, CwdChangeMeta, FileCardMeta, GuardCause, HistoryCardMeta, MemoryCardMeta, MemoryItem, Message, PendingItem, SessionStatus, SettingsChangeMeta, SourceCardMeta, ToolCategory, UntrustedKind } from '@spica/protocol';
import { humanError } from '../../../shared/errors';
import { toolLabel } from '../chat/format';

export { humanError } from '../../../shared/errors';

export interface SuggestAction {
  label: string;
  prompt: string;
}

/**
 * unavailable: the tool was turned off (its plugin stopped); the core ran nothing.
 * timeout: waiting for sub-tasks gave up while they keep working (not a failure).
 */
export type ToolState = 'pending' | 'running' | 'done' | 'error' | 'unavailable' | 'timeout';

/** The core's answer to a call of a tool that was turned off (nothing was run). */
const UNAVAILABLE = /Tool "[^"]+" is no longer available/;
/** The core's answer when waiting for sub-tasks ran out of time; they are still working. */
const WAIT_TIMEOUT = /Stopped waiting \(timeout\)/;
function failedState(text: string | undefined): ToolState {
  if (text && UNAVAILABLE.test(text)) return 'unavailable';
  if (text && WAIT_TIMEOUT.test(text)) return 'timeout';
  return 'error';
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool';
      callId: string;
      name: string;
      input: unknown;
      state: ToolState;
      preview?: string;
      result?: string;
      durationMs?: number;
      /** What came back looked like instructions (outside content); the core told the model to ignore them. */
      flagged?: UntrustedKind;
      /** What came back was outside content (a web page, mail, a file, a plugin's result), fenced as data by the core. */
      outside?: UntrustedKind;
      /** Irreversible, but ran without asking: the conversation's approval is automatic. */
      autoApproved?: boolean;
      /** What kind of step it is, as the core said (tool.start, or the stored toolInfo); absent in older conversations. */
      category?: ToolCategory;
      /** The model's one line on what this step does (run_command's description). */
      summary?: string;
      /** A plugin tool's name for people. */
      title?: string;
    }
  /** `cancelled`: the question was dropped unanswered (the run was stopped): nothing to answer any more. */
  | { type: 'ask'; callId: string; question: string; options: string[]; answer?: string; cancelled?: boolean }
  /** `cancelled`: dropped undecided (the run was stopped): nothing to decide any more. */
  | { type: 'confirm'; callId: string; name: string; input: unknown; reason: string; approved?: boolean; cause?: GuardCause; cancelled?: boolean }
  | { type: 'suggest'; callId: string; title: string; actions: SuggestAction[] };

/** A note from a sub-agent (its report, what the user said there, or a decision made there). */
export interface ChildNote {
  kind: 'report' | 'relay' | 'decision';
  fromSessionId: string;
  fromTitle: string | null;
  text: string;
  by?: 'user' | 'agent';
}

/** Reads ChildNoteMeta from a message; undefined for other notes. */
export function childNoteOf(m: Message): ChildNote | undefined {
  const meta = m.meta;
  if (!meta || meta.author !== 'child') return undefined;
  const kind = meta.kind;
  if (kind !== 'report' && kind !== 'relay' && kind !== 'decision') return undefined;
  if (typeof meta.fromSessionId !== 'string' || typeof meta.text !== 'string') return undefined;
  return {
    kind,
    fromSessionId: meta.fromSessionId,
    fromTitle: typeof meta.fromTitle === 'string' ? meta.fromTitle : null,
    text: meta.text,
    ...(meta.by === 'user' || meta.by === 'agent' ? { by: meta.by } : {}),
  };
}

/** The core's placeholder when a sub-agent finished without writing anything (older records). */
const NO_REPORT = '(finished without a written report)';

/** The model a modelChange meta names, or undefined. */
function modelOf(v: unknown): string | undefined {
  return v && typeof v === 'object' && typeof (v as { model?: unknown }).model === 'string' ? (v as { model: string }).model : undefined;
}

/**
 * 「工作文件夹已选为 D:\报价，移入 3 个文件，其中 1 个改了名：a.txt → a (1).txt」; for a conversation from
 * 0.1.0-rc.2 nothing moves: 「工作文件夹已选为 D:\报价，原来的文件留在 C:\…\文档\Spica」.
 */
export function cwdNoteText(c: CwdChangeMeta): string {
  if (typeof c.filesStayIn === 'string' && c.filesStayIn) return `工作文件夹已选为 ${c.to}，原来的文件留在 ${c.filesStayIn}`;
  const moved = Array.isArray(c.moved) ? c.moved.length : 0;
  const renamed = Array.isArray(c.renamed) ? c.renamed : [];
  const files = moved ? `，移入 ${moved} 个文件` : '';
  const names = renamed.length ? `，其中 ${renamed.length} 个改了名：${renamed.map((r) => `${r.from} → ${r.to}`).join('、')}` : '';
  return `工作文件夹已选为 ${c.to}${files}${names}`;
}

/**
 * A note in the conversation, in words for people. The core's own notes are
 * written for the model (English, in brackets); they are shown from their meta,
 * and one this does not know is not shown at all rather than as that text.
 */
function noteItem(m: Message): Item | undefined {
  const change = m.meta?.settingsChange;
  if (change && typeof change === 'object' && typeof change.action === 'string') return { kind: 'settings', id: m.id, change };
  // Tools this conversation used were turned off.
  const gone = m.meta?.toolsUnavailable;
  if (Array.isArray(gone) && gone.length) return { kind: 'note', id: m.id, text: `工具已停用：${gone.map((n) => toolLabel(String(n))).join('、')}` };
  // The user switched the conversation's model.
  const switched = m.meta?.modelChange as { from?: unknown; to?: unknown } | undefined;
  if (switched && typeof switched === 'object') {
    const from = modelOf(switched.from);
    const to = modelOf(switched.to);
    if (to) return { kind: 'note', id: m.id, text: from ? `已切换模型：${from} → ${to}` : `已切换模型：${to}` };
  }
  // The user chose the working folder; what the conversation had made moved there.
  const cwd = m.meta?.cwdChange;
  if (cwd && typeof cwd === 'object' && typeof cwd.to === 'string') return { kind: 'note', id: m.id, text: cwdNoteText(cwd), cwd };
  const child = childNoteOf(m);
  if (child) {
    const empty = child.kind === 'report' && (child.text.trim() === '' || child.text === NO_REPORT);
    return { kind: 'note', id: m.id, text: empty ? '无报告内容' : child.text, child: empty ? { ...child, text: '无报告内容' } : child };
  }
  if (m.meta?.author === 'runtime') return undefined;
  return { kind: 'note', id: m.id, text: textOf(m) };
}

/** Mail the core handed to a project manager (meta.mails on its message): ids into the inbox. */
export function mailIdsOf(m: Message): string[] | undefined {
  const mails = m.meta?.mails;
  if (m.meta?.author !== 'parent' || !Array.isArray(mails)) return undefined;
  const ids = mails.map((x) => (x && typeof x === 'object' ? (x as { id?: unknown }).id : undefined)).filter((x): x is string => typeof x === 'string');
  return ids.length ? ids : undefined;
}

/** Mail ids (from `mail:<id>` sources) whose text the core flagged as instruction-like. */
export function flaggedMailIds(notes: unknown): string[] {
  if (!Array.isArray(notes)) return [];
  return notes
    .filter((n): n is { kind: string; source: string; signals: unknown[] } => Boolean(n) && typeof n === 'object' && (n as { kind?: unknown }).kind === 'mail' && Array.isArray((n as { signals?: unknown }).signals))
    .filter((n) => n.signals.length > 0 && typeof n.source === 'string' && n.source.startsWith('mail:'))
    .map((n) => n.source.slice('mail:'.length));
}

function mailItem(m: Message, mailIds: string[]): Item {
  const flagged = flaggedMailIds(m.meta?.untrusted);
  return flagged.length ? { kind: 'mail', id: m.id, mailIds, flagged } : { kind: 'mail', id: m.id, mailIds };
}

/** A file attached to a message you wrote (its text went to the model; the card is what you see). */
export interface Attachment {
  path: string;
  name: string;
  file?: FileCardMeta;
  /** It could not be read. */
  failed?: boolean;
  /** A picture: the core's own copy (shown as a thumbnail). */
  image?: { path: string; width: number; height: number };
  /** Why a picture was not attached (worded by the UI). */
  code?: 'image.too_large' | 'image.too_many' | 'image.unreadable';
}

/** An earlier answer to the same message, replaced by 重新生成 (only to look at). */
export interface OldAnswer {
  blocks: Block[];
  /** When its last message was written. */
  at?: string;
}

export type Item =
  /** `at`: when it was sent. */
  | { kind: 'user'; id: string; text: string; steer: boolean; attachments?: Attachment[]; at?: string }
  /** New mail for this project (the core's English instructions to the agent are not shown). */
  | { kind: 'mail'; id: string; mailIds: string[]; flagged?: string[] }
  /** `cwd`: the working-folder note; files named before it are looked for where they went (store/relocate.ts). */
  | { kind: 'note'; id: string; text: string; child?: ChildNote; cwd?: CwdChangeMeta }
  /** A model setting a connected script changed (the card; meta.settingsChange). */
  | { kind: 'settings'; id: string; change: SettingsChangeMeta }
  /**
   * `messageIds`: the stored assistant messages in it (the last is the one 重新生成 names); `at`: when the last
   * was written; `versions`: the answers it replaced, oldest first (it is the newest, number versions.length + 1);
   * `anchorId`: the message it answers, once it has been regenerated.
   */
  | { kind: 'response'; id: string; blocks: Block[]; interrupted: boolean; messageIds?: string[]; at?: string; versions?: OldAnswer[]; anchorId?: string; truncated?: boolean };

export interface RunState {
  /** ms since epoch when this run started (for the status line timer). */
  startedAt: number;
  status: SessionStatus;
  detail?: string;
  queuePosition?: number;
}

export interface FinishedRun {
  endedAt: number;
  durationMs: number;
  reason: string;
}

export interface Transcript {
  items: Item[];
  run?: RunState;
  lastRun?: FinishedRun;
  error?: string;
  /** Where the error is put right: 'models' = 设置 › 模型 (a spending limit stopped the run); a button beside it opens it. */
  errorAction?: 'models';
  /**
   * The last run stopped at a limit with the work not done (not an error): 'max_turns' (the turn limit; the desktop
   * app sets none since 2026-11-12, a script through the MCP service may). Shown as a note after the answer.
   */
  stopped?: 'max_turns';
  /** The words of the last error the core marked retryable (a network error, 5xx, 429...): shown only if the run then ends in an error. */
  lastFailure?: string;
  /** Messages sent while a run was going, not yet taken in by the agent. */
  queued?: { id: string; text: string }[];
  /** File details the core reported (file.card), by call id: the call's first card. */
  fileCards?: Record<string, FileCardMeta>;
  /** Every card of a call that reported several (a command, present_files, a plugin tool), in order, by call id. */
  fileCardLists?: Record<string, FileCardMeta[]>;
  /** What the history tools found (history.card), by call id: the table under the tool row, and where [name](history:n) links go. */
  historyCards?: Record<string, HistoryCardMeta>;
  /** The web pages web_fetch / web_search used (source.card), by call id. */
  sourceCards?: Record<string, SourceCardMeta>;
  /** What remember / forget changed in the user's memory (memory.changed), by call id: the 已记住 line. */
  memoryCards?: Record<string, MemoryCardMeta>;
  /** The number of the first stored message in each item, by item id (to scroll to a message by its number). */
  seqs?: Record<string, number>;
}

/** The item that holds message number `seq`: the last one that starts at or before it. */
export function itemAtSeq(t: Transcript, seq: number): string | undefined {
  let found: string | undefined;
  for (const it of t.items) {
    const at = t.seqs?.[it.id];
    if (at !== undefined && at <= seq) found = it.id;
  }
  return found;
}

/** A row the model can point at as history:n in this conversation (the newest card that has it).
 *  read_history's rows share one number for the whole conversation: opened, not scrolled. */
export function historyRef(t: Transcript, ref: number): { sessionId: string; seq?: number } | undefined {
  let hit: { sessionId: string; seq?: number } | undefined;
  for (const card of Object.values(t.historyCards ?? {})) {
    const row = card.rows.find((r) => r.ref === ref);
    if (row) hit = { sessionId: row.sessionId, ...(row.seq !== undefined && card.tool !== 'read_history' ? { seq: row.seq } : {}) };
  }
  return hit;
}

export const EMPTY_TRANSCRIPT: Transcript = { items: [] };

/** What tool.start says about a call beyond its name and input: its kind, the model's line on it, a plugin tool's title. */
function aboutCall(e: { category?: ToolCategory; summary?: string; title?: string }): { category?: ToolCategory; summary?: string; title?: string } {
  return { ...(e.category ? { category: e.category } : {}), ...(e.summary ? { summary: e.summary } : {}), ...(e.title ? { title: e.title } : {}) };
}

/** Tools that read or write a file; their `path` becomes a file card under the answer. */
export const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);
const ASK_TOOL = 'ask_user';
const SUGGEST_TOOL = 'suggest_actions';

/** The core's memory tools: shown as the 已记住 line, not in the group of steps. */
export const MEMORY_TOOLS = new Set(['remember', 'forget']);

/**
 * The 已记住 / 已更新 / 已忘记 line of a remember or forget call, as the item is now (`now`: the item in the
 * memory, with replaced and forgotten ones; undefined while not known). 撤销 only while the change still
 * stands; 已撤销 once it was undone; a change later deleted or replaced in the settings keeps its words only.
 */
export function memoryLine(card: MemoryCardMeta, now: MemoryItem | undefined): { text: string; undo: boolean } | undefined {
  const item = card.item;
  if (!item) return undefined;
  const undone = card.action === 'forgotten' ? now?.status === 'active' : now?.undone === true;
  if (undone) return { text: `已撤销：${item.text}`, undo: false };
  const stands = !now || (card.action === 'forgotten' ? now.status === 'forgotten' : now.status === 'active');
  if (card.action === 'replaced') return { text: `已更新：${item.text}${card.previous ? `（替换「${card.previous.text}」）` : ''}`, undo: stands };
  if (card.action === 'forgotten') return { text: `已忘记：${item.text}`, undo: stands };
  if (card.action === 'saved') return { text: `已记住：${item.text}`, undo: stands };
  return undefined;
}

function textOf(message: Message): string {
  // The text of attached files rides in their own content blocks: not part of what was typed.
  const hidden = new Set((attachmentsOf(message) ?? []).map((a) => a.block).filter((b): b is number => typeof b === 'number'));
  return message.content
    .map((b, i) => (hidden.has(i) ? '' : b.type === 'text' ? b.text : b.type === 'opaque' ? (b.text ?? '') : ''))
    .join('');
}

function attachmentsOf(m: Message): { path: string; name: string; block: number | null; file?: FileCardMeta; error?: string; image?: { path: string; width: number; height: number }; code?: Attachment['code'] }[] | undefined {
  const list = m.meta?.attachments;
  return Array.isArray(list) && list.length ? list : undefined;
}

function userItem(m: Message): Item {
  const list = attachmentsOf(m);
  const att = list?.map(
    (a): Attachment => ({
      path: a.path,
      name: a.name,
      ...(a.file ? { file: a.file } : {}),
      ...(a.image ? { image: { path: a.image.path, width: a.image.width, height: a.image.height } } : a.block === null ? { failed: true } : {}),
      ...(a.code ? { code: a.code } : {}),
    }),
  );
  // With attachments, the first block is what was typed; the rest is for the model (a file that
  // could not be read is said in English there, and shown here as the attachment marked failed).
  const first = m.content[0];
  const text = list?.length ? (first?.type === 'text' ? first.text : '') : textOf(m);
  return { kind: 'user', id: m.id, text, steer: m.kind === 'steer', ...(att ? { attachments: att } : {}), ...(m.createdAt ? { at: m.createdAt } : {}) };
}

function asSuggest(callId: string, input: unknown): Block {
  const v = (input && typeof input === 'object' ? input : {}) as { title?: unknown; actions?: unknown };
  const actions = Array.isArray(v.actions)
    ? v.actions
        .map((a) => (a && typeof a === 'object' ? (a as Record<string, unknown>) : {}))
        .filter((a) => typeof a.label === 'string')
        .map((a) => ({ label: String(a.label), prompt: typeof a.prompt === 'string' ? a.prompt : String(a.label) }))
    : [];
  return { type: 'suggest', callId, title: typeof v.title === 'string' ? v.title : '', actions };
}

function asAsk(callId: string, input: unknown): Block {
  const v = (input && typeof input === 'object' ? input : {}) as { question?: unknown; options?: unknown };
  return {
    type: 'ask',
    callId,
    question: typeof v.question === 'string' ? v.question : '',
    options: Array.isArray(v.options) ? v.options.map(String) : [],
  };
}

/** Strips the fetch-time first line the core puts on every tool result. */
export function resultBody(raw: string): string {
  // Outside content arrives fenced for the model (<untrusted_data …> … </untrusted_data>): shown without the fence.
  const content = raw.replace(/^<untrusted_data\b[^>]*>\n?/, '').replace(/\n?<\/untrusted_data>\s*$/, '');
  const nl = content.indexOf('\n');
  const first = nl < 0 ? content : content.slice(0, nl);
  // The core writes "[fetched at <ISO>]"; older/fake results use a bare ISO line.
  return /^(\[fetched at [^\]]*\]|\d{4}-\d{2}-\d{2}T\S*)\s*$/.test(first) ? (nl < 0 ? '' : content.slice(nl + 1)) : content;
}

/** The user's answer inside an ask_user result ("User answered: X" from the core). */
export function askAnswer(content: string): string {
  return resultBody(content).replace(/^User answered:\s*/, '');
}

function lastResponse(items: Item[], id: string): Extract<Item, { kind: 'response' }> {
  const last = items[items.length - 1];
  if (last?.kind === 'response') return last;
  const created: Item = { kind: 'response', id, blocks: [], interrupted: false };
  items.push(created);
  return created;
}

/**
 * Questions and confirmations still open in `items` that the core no longer waits on (the run was stopped while
 * they waited): marked cancelled, and their answer marked interrupted like an answer stopped while it ran.
 * `keep`: call ids the core still waits on. Mutates `items`.
 */
function cancelOpenCards(items: Item[], keep: ReadonlySet<string> = new Set()): void {
  for (const it of items) {
    if (it.kind !== 'response') continue;
    for (const b of it.blocks) {
      if (keep.has((b as { callId?: string }).callId ?? '')) continue;
      if ((b.type === 'ask' && b.answer === undefined && !b.cancelled) || (b.type === 'confirm' && b.approved === undefined && !b.cancelled)) {
        b.cancelled = true;
        it.interrupted = true;
      }
    }
  }
}

/** A tool result for a question or a confirmation: an answer, or (an error: the core cancelled it) cancelled. */
function settleCard(items: Item[], callId: string, content: string, isError: boolean | undefined): void {
  const ask = findBlock(items, 'ask', callId);
  if (ask && ask.answer === undefined) {
    if (isError) {
      ask.cancelled = true;
      markInterrupted(items, callId);
    } else ask.answer = askAnswer(content);
  }
  const confirm = findBlock(items, 'confirm', callId);
  if (confirm && confirm.approved === undefined && isError && /^Cancelled\b/.test(resultBody(content))) {
    confirm.cancelled = true;
    markInterrupted(items, callId);
  }
}

function markInterrupted(items: Item[], callId: string): void {
  const it = items.find((i) => i.kind === 'response' && i.blocks.some((b) => (b as { callId?: string }).callId === callId));
  if (it?.kind === 'response') it.interrupted = true;
}

/** The card `callId` marked cancelled (the core said it no longer waits on it). */
export function cancelCard(prev: Transcript, callId: string): Transcript {
  const t = clone(prev);
  for (const type of ['ask', 'confirm'] as const) {
    const b = findBlock(t.items, type, callId);
    if (b) b.cancelled = true;
  }
  return t;
}

function findBlock<T extends Block['type']>(items: Item[], type: T, callId: string): Extract<Block, { type: T }> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.kind !== 'response') continue;
    for (const b of it.blocks) if (b.type === type && 'callId' in b && b.callId === callId) return b as Extract<Block, { type: T }>;
  }
  return undefined;
}

/** Builds the view from stored history plus whatever the session is still waiting on. */
export function fromHistory(all: readonly Message[], pending: readonly PendingItem[] = []): Transcript {
  // Answers replaced by 重新生成: each old version is built the same way, then hung on the answer that replaced it.
  const old = new Map<string, Map<number, Message[]>>();
  for (const m of all) {
    if (!m.superseded) continue;
    const byVersion = old.get(m.superseded.of) ?? new Map<number, Message[]>();
    byVersion.set(m.superseded.version, [...(byVersion.get(m.superseded.version) ?? []), m]);
    old.set(m.superseded.of, byVersion);
  }
  const messages = old.size ? all.filter((m) => !m.superseded) : all;
  const items: Item[] = [];
  const cards: Record<string, FileCardMeta> = {};
  const cardLists: Record<string, FileCardMeta[]> = {};
  const sources: Record<string, SourceCardMeta> = {};
  const history: Record<string, HistoryCardMeta> = {};
  const memory: Record<string, MemoryCardMeta> = {};
  const seqs: Record<string, number> = {};
  // After each message: the item it went into starts at that message's number (if it is the first one there).
  const mark = (m: Message) => {
    const last = items[items.length - 1];
    if (last && !(last.id in seqs)) seqs[last.id] = m.seq;
  };
  for (const m of messages) {
    const found = m.meta?.historyCards;
    if (found && typeof found === 'object') Object.assign(history, found);
    if (m.role === 'assistant') {
      const r = lastResponse(items, m.id);
      r.messageIds = [...(r.messageIds ?? []), m.id];
      if (m.createdAt) r.at = m.createdAt;
      if (m.meta?.interrupted === true) r.interrupted = true;
      // the answer's last part stopped at the most output the model may give: not finished (a note and 继续)
      if (m.kind === 'assistant') r.truncated = m.meta?.stopReason === 'max_tokens';
      for (const b of m.content) {
        if (b.type === 'text') {
          const prev = r.blocks[r.blocks.length - 1];
          if (prev?.type === 'text') prev.text += b.text;
          else r.blocks.push({ type: 'text', text: b.text });
        } else if (b.type === 'opaque' && b.text) {
          r.blocks.push({ type: 'text', text: b.text });
        } else if (b.type === 'thinking' && !b.redacted && b.text) {
          r.blocks.push({ type: 'thinking', text: b.text });
        } else if (b.type === 'tool_use') {
          if (b.name === SUGGEST_TOOL) r.blocks.push(asSuggest(b.id, b.input));
          else if (b.name === ASK_TOOL) r.blocks.push(asAsk(b.id, b.input));
          else r.blocks.push({ type: 'tool', callId: b.id, name: b.name, input: b.input, state: 'done' });
        }
      }
      mark(m);
      continue;
    }
    if (m.kind === 'tool_results') {
      const stored = m.meta?.fileCards;
      if (stored && typeof stored === 'object') Object.assign(cards, stored as Record<string, FileCardMeta>);
      const storedLists = m.meta?.fileCardLists;
      if (storedLists && typeof storedLists === 'object') Object.assign(cardLists, storedLists);
      const storedSources = m.meta?.sourceCards;
      if (storedSources && typeof storedSources === 'object') Object.assign(sources, storedSources);
      const storedMemory = m.meta?.memoryCards;
      if (storedMemory && typeof storedMemory === 'object') Object.assign(memory, storedMemory);
      const info = m.meta?.toolInfo;
      // Suggestion cards as the core stored them (they win over the tool call's raw input).
      const suggested = m.meta?.suggestedActions as Record<string, { title: string; actions: SuggestAction[] }> | undefined;
      for (const [callId, sa] of Object.entries(suggested ?? {})) {
        const b = findBlock(items, 'suggest', callId);
        if (b) {
          b.title = sa.title;
          b.actions = sa.actions.map((a) => ({ label: a.label, prompt: a.prompt }));
        }
      }
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        const tool = findBlock(items, 'tool', b.toolUseId);
        if (tool) {
          const about = info?.[b.toolUseId];
          if (about?.category) tool.category = about.category;
          if (about?.summary) tool.summary = about.summary;
          if (about?.title) tool.title = about.title;
          tool.result = resultBody(b.content);
          tool.preview = tool.result.slice(0, 160);
          tool.state = b.isError ? failedState(b.content) : 'done';
          const note = m.meta?.guard?.[b.toolUseId];
          if (note) tool.outside = note.kind;
          if (note?.signals?.length) tool.flagged = note.kind;
          if (m.meta?.autoApproved?.includes(b.toolUseId)) tool.autoApproved = true;
          continue;
        }
        settleCard(items, b.toolUseId, b.content, b.isError);
      }
      mark(m);
      continue;
    }
    const mailIds = mailIdsOf(m);
    if (mailIds) items.push(mailItem(m, mailIds));
    else if (m.kind === 'user' || m.kind === 'steer') items.push(userItem(m));
    else {
      const note = noteItem(m);
      if (note) items.push(note);
    }
    mark(m);
  }
  for (const [anchor, byVersion] of old) {
    const at = items.findIndex((i) => i.id === anchor);
    if (at < 0) continue;
    const versions = [...byVersion.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, msgs]): OldAnswer => {
        // Built as if current (each still carries its mark, which would leave it out again).
        const built = fromHistory(
          msgs.map((m) => {
            const { superseded, ...rest } = m;
            void superseded;
            return rest;
          }),
        );
        Object.assign(cards, built.fileCards ?? {});
        Object.assign(cardLists, built.fileCardLists ?? {});
        Object.assign(sources, built.sourceCards ?? {});
        Object.assign(history, built.historyCards ?? {});
        Object.assign(memory, built.memoryCards ?? {});
        const last = msgs[msgs.length - 1];
        return { blocks: built.items.flatMap((i) => (i.kind === 'response' ? i.blocks : [])), ...(last?.createdAt ? { at: last.createdAt } : {}) };
      });
    // The newest answer (maybe still empty: it is being written) is the response right after the message.
    let cur = items[at + 1];
    if (cur?.kind !== 'response') {
      cur = { kind: 'response', id: `answer-${anchor}`, blocks: [], interrupted: false };
      items.splice(at + 1, 0, cur);
    }
    cur.versions = versions;
    cur.anchorId = anchor;
  }
  const t: Transcript = {
    items,
    ...(Object.keys(cards).length ? { fileCards: cards } : {}),
    ...(Object.keys(cardLists).length ? { fileCardLists: cardLists } : {}),
    ...(Object.keys(sources).length ? { sourceCards: sources } : {}),
    ...(Object.keys(history).length ? { historyCards: history } : {}),
    ...(Object.keys(memory).length ? { memoryCards: memory } : {}),
    seqs,
  };
  for (const p of pending) applyPending(t, p);
  // A question or confirmation with no result that the core no longer waits on was dropped (stopped before the
  // core wrote its result): nothing to answer.
  cancelOpenCards(t.items, new Set(pending.map((p) => p.callId)));
  return t;
}

function applyPending(t: Transcript, p: PendingItem): void {
  if (p.kind === 'ask') {
    const existing = findBlock(t.items, 'ask', p.callId);
    if (existing) {
      existing.question = p.question || existing.question;
      existing.options = p.options ?? existing.options;
    } else {
      lastResponse(t.items, `pending-${p.callId}`).blocks.push({ type: 'ask', callId: p.callId, question: p.question, options: p.options ?? [] });
    }
  } else {
    if (!findBlock(t.items, 'confirm', p.callId)) {
      lastResponse(t.items, `pending-${p.callId}`).blocks.push({ type: 'confirm', callId: p.callId, name: p.toolName, input: p.input, reason: p.reason, ...(p.cause ? { cause: p.cause } : {}) });
    }
  }
}

function clone(t: Transcript): Transcript {
  return structuredClone(t);
}

const RUNNING: ReadonlySet<SessionStatus> = new Set(['queued', 'thinking', 'tool', 'awaiting_confirm', 'awaiting_answer']);

export function isRunning(status: SessionStatus | undefined): boolean {
  return status !== undefined && RUNNING.has(status);
}

/** Applies one live event. Returns a new transcript (never mutates the input). */
export function applyEvent(prev: Transcript, e: CoreEvent, now: number = Date.now()): Transcript {
  const t = clone(prev);
  const items = t.items;
  const respId = `live-${e.seq}`;
  switch (e.type) {
    case 'message': {
      const m = e.message;
      const mailIds = m.role === 'user' ? mailIdsOf(m) : undefined;
      if (mailIds) {
        if (!items.some((i) => i.id === m.id)) items.push(mailItem(m, mailIds));
      } else if (m.role === 'user' && (m.kind === 'user' || m.kind === 'steer')) {
        if (!items.some((i) => i.id === m.id)) items.push(userItem(m));
        if (t.queued?.some((q) => q.id === m.id)) t.queued = t.queued.filter((q) => q.id !== m.id);
      } else if (m.role === 'user' && (m.kind === 'relay' || m.kind === 'report' || m.kind === 'note')) {
        const note = items.some((i) => i.id === m.id) ? undefined : noteItem(m);
        if (note) items.push(note);
      } else if (m.role === 'assistant' && m.meta?.interrupted === true) {
        lastResponse(items, respId).interrupted = true;
      } else if (m.role === 'assistant' && m.kind === 'assistant') {
        lastResponse(items, respId).truncated = m.meta?.stopReason === 'max_tokens';
      } else if (m.kind === 'tool_results') {
        // Stopping while a question or confirmation waits: the core writes its result as cancelled.
        for (const b of m.content) if (b.type === 'tool_result') settleCard(items, b.toolUseId, b.content, b.isError);
      }
      return t;
    }
    case 'messages.superseded': {
      const at = items.findIndex((i) => i.id === e.anchorId);
      if (at < 0) return t;
      const cur = items[at + 1];
      const versions = cur?.kind === 'response' ? [...(cur.versions ?? []), { blocks: cur.blocks, ...(cur.at ? { at: cur.at } : {}) }] : [];
      const next: Item = { kind: 'response', id: respId, blocks: [], interrupted: false, versions, anchorId: e.anchorId };
      if (cur?.kind === 'response') items.splice(at + 1, 1, next);
      else items.splice(at + 1, 0, next);
      // Whatever came after the old answer (its notes) went with it; the new answer is written last.
      items.splice(at + 2);
      return t;
    }
    case 'text.delta': {
      const r = lastResponse(items, respId);
      const prevBlock = r.blocks[r.blocks.length - 1];
      if (prevBlock?.type === 'text') prevBlock.text += e.delta;
      else r.blocks.push({ type: 'text', text: e.delta });
      return t;
    }
    case 'thinking.delta': {
      const r = lastResponse(items, respId);
      const prevBlock = r.blocks[r.blocks.length - 1];
      if (prevBlock?.type === 'thinking') prevBlock.text += e.delta;
      else r.blocks.push({ type: 'thinking', text: e.delta });
      return t;
    }
    case 'tool.call': {
      if (e.name === ASK_TOOL || e.name === SUGGEST_TOOL) return t;
      if (findBlock(items, 'tool', e.callId)) return t;
      lastResponse(items, respId).blocks.push({ type: 'tool', callId: e.callId, name: e.name, input: undefined, state: 'pending' });
      return t;
    }
    case 'tool.start': {
      if (e.name === SUGGEST_TOOL) {
        if (!findBlock(items, 'suggest', e.callId)) lastResponse(items, respId).blocks.push(asSuggest(e.callId, e.input));
        return t;
      }
      if (e.name === ASK_TOOL) return t;
      const existing = findBlock(items, 'tool', e.callId);
      if (existing) {
        existing.input = e.input;
        existing.state = 'running';
        Object.assign(existing, aboutCall(e));
      } else {
        lastResponse(items, respId).blocks.push({ type: 'tool', callId: e.callId, name: e.name, input: e.input, state: 'running', ...aboutCall(e) });
      }
      return t;
    }
    case 'file.card': {
      t.fileCards = { ...(t.fileCards ?? {}), [e.callId]: e.file };
      if (e.files?.length) t.fileCardLists = { ...(t.fileCardLists ?? {}), [e.callId]: e.files };
      return t;
    }
    case 'source.card': {
      t.sourceCards = { ...(t.sourceCards ?? {}), [e.callId]: e.card };
      return t;
    }
    case 'history.card': {
      t.historyCards = { ...(t.historyCards ?? {}), [e.callId]: e.card };
      return t;
    }
    case 'memory.changed': {
      // Changes made in the settings come without a call id (they are not a line in a conversation).
      if (e.callId) t.memoryCards = { ...(t.memoryCards ?? {}), [e.callId]: e.card };
      return t;
    }
    case 'tool.end': {
      const tool = findBlock(items, 'tool', e.callId);
      if (tool) {
        tool.state = e.isError ? failedState(e.preview) : 'done';
        tool.preview = e.preview;
        tool.durationMs = e.durationMs;
      }
      return t;
    }
    case 'confirm.request': {
      if (!findBlock(items, 'confirm', e.callId)) {
        lastResponse(items, respId).blocks.push({ type: 'confirm', callId: e.callId, name: e.name, input: e.input, reason: e.reason, ...(e.cause ? { cause: e.cause } : {}) });
      }
      return t;
    }
    case 'confirm.auto': {
      const tool = findBlock(items, 'tool', e.callId);
      if (tool) tool.autoApproved = true;
      return t;
    }
    case 'guard.flagged': {
      // A tool's outside content looked like instructions (mail handed over is marked on its message instead).
      const tool = e.callId ? findBlock(items, 'tool', e.callId) : undefined;
      if (tool && e.note.signals.length) tool.flagged = e.note.kind;
      if (tool) tool.outside = e.note.kind;
      return t;
    }
    case 'confirm.resolved': {
      const c = findBlock(items, 'confirm', e.callId);
      if (c) c.approved = e.approved;
      return t;
    }
    case 'ask.request': {
      const existing = findBlock(items, 'ask', e.callId);
      if (existing) {
        existing.question = e.question;
        existing.options = e.options ?? [];
        delete existing.cancelled;
      } else {
        lastResponse(items, respId).blocks.push({ type: 'ask', callId: e.callId, question: e.question, options: e.options ?? [] });
      }
      return t;
    }
    case 'ask.resolved': {
      const a = findBlock(items, 'ask', e.callId);
      if (a) a.answer = e.answer;
      return t;
    }
    case 'status': {
      if (isRunning(e.status)) {
        const startedAt = t.run?.startedAt ?? now;
        t.run = { startedAt, status: e.status, ...(e.detail ? { detail: e.detail } : {}) };
        delete t.error;
        delete t.errorAction;
        delete t.stopped;
        delete t.lastFailure;
      } else if (t.run) {
        t.lastRun = { endedAt: now, durationMs: now - t.run.startedAt, reason: e.status };
        delete t.run;
      }
      // Stopped: whatever it was still asking is dropped.
      if (e.status === 'aborted') cancelOpenCards(items);
      return t;
    }
    case 'queue': {
      if (t.run) t.run.queuePosition = e.position;
      return t;
    }
    case 'suggest.actions': {
      const actions = e.actions.map((a) => ({ label: a.label, prompt: a.prompt }));
      const existing = findBlock(items, 'suggest', e.callId);
      if (existing) {
        existing.title = e.title;
        existing.actions = actions;
      } else {
        lastResponse(items, respId).blocks.push({ type: 'suggest', callId: e.callId, title: e.title, actions });
      }
      return t;
    }
    case 'error': {
      // The main process adds the core's own words for errors it knows by code (WSO2 faults).
      const hint = (e as { hint?: unknown }).hint;
      const words = typeof hint === 'string' && hint ? hint : humanError(e.message);
      // `retryable` says what kind of error it is (network, 5xx, 429), not that the core is still trying:
      // the core's retries and its final error both carry it. Such an error is shown when the run ends
      // in an error (run.end); a retry that then succeeds leaves nothing behind.
      if (e.retryable) t.lastFailure = words;
      else t.error = words;
      return t;
    }
    case 'run.end': {
      if (e.reason === 'error' && !t.error) {
        const words = t.lastFailure ?? (e.detail ? humanError(e.detail) : undefined);
        if (words) t.error = words;
      }
      delete t.lastFailure;
      if (e.reason === 'max_turns') t.stopped = 'max_turns';
      return t;
    }
    case 'budget.stop': {
      t.error = budgetStopWords(e);
      t.errorAction = 'models';
      return t;
    }
    default:
      return t;
  }
}

/**
 * A spending limit stopped the run. The limit is checked before each call against its worst case, so the run can
 * stop with less spent than the limit: say that the next step was not started because it could have gone past it.
 */
export function budgetStopWords(e: { scope: string; spentUsd: number; limitUsd: number; nextUsd?: number }): string {
  const run = e.scope.endsWith(':run');
  const name = run ? '单次运行花费上限' : '花费上限';
  const why = e.nextUsd !== undefined ? `下一步最多可能花 ${formatMoney(e.nextUsd)}，会超出上限，所以没有开始` : '下一步可能超出上限，所以没有开始';
  const after = run ? '可在 设置 › 模型 修改上限，或再发一条消息重新开始一次运行。' : '可在 设置 › 模型 修改上限。';
  return `已达${name}，已停止（已花费 ${formatMoney(e.spentUsd)}，上限 ${formatMoney(e.limitUsd)}）：${why}。${after}`;
}

function formatMoney(usd: number): string {
  return 'US$' + usd.toFixed(2);
}

export interface FileRef {
  /** Absolute when the core reported the file, otherwise as the model wrote it; where it went when the working folder moved it. */
  path: string;
  /** Shown instead of `path` (name and folder) when the file was moved into the conversation's folder: its path in there. */
  shown?: string;
  tool: string;
  card?: FileCardMeta;
  /** The kind of step the card came from (a command's cards say the file changed while it ran). */
  category?: ToolCategory;
  /** Lines added and removed by this round's writes and edits of the file, added up. */
  lines?: { added: number; removed: number };
}

/**
 * Files the answer touched, one card each. A call may report several cards (`lists`, else its one card in
 * `cards`); older conversations have none for write_file / edit_file, whose path argument stands in. When a
 * file has several cards in the round: the one present_files handed over (those come first), else the latest;
 * a card wins over a bare path; lines are added up over the round's writes and edits.
 * `moved`: the working-folder change after this answer, if any: the paths are where the files are now.
 */
export function filesOf(blocks: readonly Block[], cards: Record<string, FileCardMeta> = {}, moved?: CwdChangeMeta, lists: Record<string, FileCardMeta[]> = {}): FileRef[] {
  const seen = new Map<string, { ref: FileRef; order: number; presented: boolean }>();
  const lines = new Map<string, { added: number; removed: number }>();
  let order = 0;
  for (const b of blocks) {
    if (b.type !== 'tool' || b.state === 'error') continue;
    const one = cards[b.callId];
    const list = lists[b.callId] ?? (one ? [one] : []);
    const arg = (b.input as { path?: unknown } | undefined)?.path;
    const entries: { written: string; card?: FileCardMeta }[] = list.length ? list.map((card) => ({ written: card.path, card })) : FILE_TOOLS.has(b.name) && typeof arg === 'string' ? [{ written: arg }] : [];
    const presented = b.name === 'present_files' || b.category === 'present';
    for (const { written, card } of entries) {
      const path = relocate(written, moved);
      if (!path) continue;
      if (card?.lines) {
        const sum = lines.get(path) ?? { added: 0, removed: 0 };
        lines.set(path, { added: sum.added + card.lines.added, removed: sum.removed + card.lines.removed });
      }
      const prev = seen.get(path);
      // A bare path never replaces a card or an earlier path; a later card does, unless present_files handed the file over.
      if (prev && (!card || (prev.presented && !presented))) continue;
      const shown = path !== written ? shownPath(path, moved) : undefined;
      const ref: FileRef = { path, tool: b.name, ...(shown && shown !== path ? { shown } : {}), ...(card ? { card } : {}), ...(b.category ? { category: b.category } : {}) };
      seen.set(path, { ref, order: prev?.order ?? order++, presented: presented || (prev?.presented ?? false) });
    }
  }
  const all = [...seen.values()];
  all.sort((a, b) => Number(b.presented) - Number(a.presented) || a.order - b.order);
  return all.map(({ ref }) => {
    const sum = lines.get(ref.path);
    return sum && (sum.added || sum.removed) ? { ...ref, lines: sum } : ref;
  });
}

/**
 * What a card says the round did with the file, in the tool rows' English (a card for a file that was read
 * says what was read instead, fileCardLine): Created, Edited, Made, or for a command's cards, changed while it ran.
 */
export function fileCardVerb(f: FileRef): string | null {
  const origin = f.card?.origin;
  const command = f.category === 'command' || f.tool === 'run_command';
  if (origin === 'created') return command ? 'Created while the command ran' : 'Created';
  if (origin === 'modified') return command ? 'Changed while the command ran' : 'Edited';
  if (origin === 'produced') return 'Made';
  return null;
}

const KIND_LABEL: Record<FileCardMeta['kind'], string> = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel', csv: 'CSV', pptx: 'PPT', text: '文本', other: '文件' };

/** One line under the file name: what kind, how big, what was read, and anything to watch out for. */
export function fileCardLine(card: FileCardMeta): string {
  const { kind, read } = fileCardParts(card);
  return read ? `${kind} · ${read}` : kind;
}

/** The two halves of fileCardLine: what the file is (PDF · 4 页) and what was read of it (Read pages 1-3). */
export function fileCardParts(card: FileCardMeta): { kind: string; read: string } {
  const kind: string[] = [KIND_LABEL[card.kind] ?? card.kind];
  if (card.pageCount) kind.push(`${card.pageCount} 页`);
  if (card.sheets?.length) kind.push(`${card.sheets.length} 个表`);
  if (card.slideCount) kind.push(`${card.slideCount} 页幻灯片`);
  const parts: string[] = [];
  const r = card.read;
  const sheetsRead = r.sheet ? r.sheet.split(/,\s*/).filter(Boolean) : [];
  const wholeFile =
    (r.pages !== undefined && card.pageCount !== undefined && (r.pages === `1-${card.pageCount}` || (card.pageCount === 1 && r.pages === '1'))) ||
    (card.sheets !== undefined && sheetsRead.length === card.sheets.length && !r.rows && !r.range);
  // What was done with it in English, like the tool lines (Read, Read pages 1-3); what the file is stays Chinese.
  if (wholeFile && !card.truncated) parts.push('Read');
  else if (r.pages) parts.push(/[-,]/.test(r.pages) ? `Read pages ${r.pages}` : `Read page ${r.pages}`);
  else if (r.sheet) parts.push(`Read ${sheetsRead.map((n) => `「${n}」`).join(', ')}${r.range ? ` ${r.range}` : r.rows ? ` rows ${r.rows}` : ''}`);
  else if (r.range) parts.push(`Read ${r.range}`);
  else if (r.rows) parts.push(`Read rows ${r.rows}`);
  if (card.noTextLayer) parts.push('扫描件，无法读取文字');
  else if (card.truncated) parts.push('Partly read');
  return { kind: kind.join(' · '), read: parts.join(' · ') };
}
