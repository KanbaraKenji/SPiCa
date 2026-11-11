// Turns a session's history (Message[] + pending items) and its live event
// stream into what the conversation view draws. Pure functions, no React.
import { relocate, shownPath } from './relocate';
import type { CoreEvent, CwdChangeMeta, FileCardMeta, GuardCause, HistoryCardMeta, Message, PendingItem, SessionStatus, SettingsChangeMeta, UntrustedKind } from '@spica/protocol';
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
      /** Irreversible, but ran without asking: the conversation's approval is automatic. */
      autoApproved?: boolean;
    }
  | { type: 'ask'; callId: string; question: string; options: string[]; answer?: string }
  | { type: 'confirm'; callId: string; name: string; input: unknown; reason: string; approved?: boolean; cause?: GuardCause }
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
  | { kind: 'response'; id: string; blocks: Block[]; interrupted: boolean; messageIds?: string[]; at?: string; versions?: OldAnswer[]; anchorId?: string };

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
  /** The words of the last error the core marked retryable (a network error, 5xx, 429...): shown only if the run then ends in an error. */
  lastFailure?: string;
  /** Messages sent while a run was going, not yet taken in by the agent. */
  queued?: { id: string; text: string }[];
  /** File details the core reported for read_file calls (file.card), by call id. */
  fileCards?: Record<string, FileCardMeta>;
  /** What the history tools found (history.card), by call id: the table under the tool row, and where [name](history:n) links go. */
  historyCards?: Record<string, HistoryCardMeta>;
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

/** Tools that read or write a file; their `path` becomes a file card under the answer. */
export const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);
const ASK_TOOL = 'ask_user';
const SUGGEST_TOOL = 'suggest_actions';

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
  const history: Record<string, HistoryCardMeta> = {};
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
          tool.result = resultBody(b.content);
          tool.preview = tool.result.slice(0, 160);
          tool.state = b.isError ? failedState(b.content) : 'done';
          const note = m.meta?.guard?.[b.toolUseId];
          if (note?.signals?.length) tool.flagged = note.kind;
          if (m.meta?.autoApproved?.includes(b.toolUseId)) tool.autoApproved = true;
          continue;
        }
        const ask = findBlock(items, 'ask', b.toolUseId);
        if (ask) ask.answer = askAnswer(b.content);
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
        Object.assign(history, built.historyCards ?? {});
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
  const t: Transcript = { items, ...(Object.keys(cards).length ? { fileCards: cards } : {}), ...(Object.keys(history).length ? { historyCards: history } : {}), seqs };
  for (const p of pending) applyPending(t, p);
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
      } else {
        lastResponse(items, respId).blocks.push({ type: 'tool', callId: e.callId, name: e.name, input: e.input, state: 'running' });
      }
      return t;
    }
    case 'file.card': {
      t.fileCards = { ...(t.fileCards ?? {}), [e.callId]: e.file };
      return t;
    }
    case 'history.card': {
      t.historyCards = { ...(t.historyCards ?? {}), [e.callId]: e.card };
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
        delete t.lastFailure;
      } else if (t.run) {
        t.lastRun = { endedAt: now, durationMs: now - t.run.startedAt, reason: e.status };
        delete t.run;
      }
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
      return t;
    }
    case 'budget.stop': {
      t.error = `已达花费上限，已停止（已花费 ${formatMoney(e.spentUsd)}，上限 ${formatMoney(e.limitUsd)}）。`;
      return t;
    }
    default:
      return t;
  }
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
}

/**
 * Files the answer touched, in first-seen order; core file cards win over the bare path argument.
 * `moved`: the working-folder change after this answer, if any: the paths are where the files are now.
 */
export function filesOf(blocks: readonly Block[], cards: Record<string, FileCardMeta> = {}, moved?: CwdChangeMeta): FileRef[] {
  const seen = new Map<string, FileRef>();
  for (const b of blocks) {
    if (b.type !== 'tool' || !FILE_TOOLS.has(b.name) || b.state === 'error') continue;
    const card = cards[b.callId];
    const arg = (b.input as { path?: unknown } | undefined)?.path;
    const written = card?.path ?? (typeof arg === 'string' ? arg : undefined);
    const path = written ? relocate(written, moved) : undefined;
    if (!path || seen.has(path)) continue;
    const shown = path !== written ? shownPath(path, moved) : undefined;
    seen.set(path, { path, tool: b.name, ...(shown && shown !== path ? { shown } : {}), ...(card ? { card } : {}) });
  }
  return [...seen.values()];
}

const KIND_LABEL: Record<FileCardMeta['kind'], string> = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel', csv: 'CSV', pptx: 'PPT', text: '文本' };

/** One line under the file name: what kind, how big, what was read, and anything to watch out for. */
export function fileCardLine(card: FileCardMeta): string {
  const parts: string[] = [KIND_LABEL[card.kind] ?? card.kind];
  if (card.pageCount) parts.push(`${card.pageCount} 页`);
  if (card.sheets?.length) parts.push(`${card.sheets.length} 个表`);
  if (card.slideCount) parts.push(`${card.slideCount} 页幻灯片`);
  const r = card.read;
  const sheetsRead = r.sheet ? r.sheet.split(/,\s*/).filter(Boolean) : [];
  const wholeFile =
    (r.pages !== undefined && card.pageCount !== undefined && (r.pages === `1-${card.pageCount}` || (card.pageCount === 1 && r.pages === '1'))) ||
    (card.sheets !== undefined && sheetsRead.length === card.sheets.length && !r.rows && !r.range);
  if (wholeFile && !card.truncated) parts.push('已全部读取');
  else if (r.pages) parts.push(`已读取第 ${r.pages} 页`);
  else if (r.sheet) parts.push(`已读取「${sheetsRead.join('、')}」${r.range ?? (r.rows ? `第 ${r.rows} 行` : '')}`);
  else if (r.range) parts.push(`已读取 ${r.range}`);
  else if (r.rows) parts.push(`已读取第 ${r.rows} 行`);
  if (card.noTextLayer) parts.push('扫描件，无法读取文字');
  else if (card.truncated) parts.push('未读完');
  return parts.join(' · ');
}
