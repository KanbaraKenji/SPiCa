// Turns a session's history (Message[] + pending items) and its live event
// stream into what the conversation view draws. Pure functions, no React.
import { relocate, shownPath } from './relocate';
import type { ReviewNoteMeta, ChangePreview, CommandJob, ConfirmAnswer, ConfirmHandover, InstallFailure, InstallPreview, CoreEvent, CwdChangeMeta, FileCardMeta, GuardCause, HistoryCardMeta, MemoryCardMeta, MemoryItem, Message, PendingItem, SessionStatus, SettingsChangeMeta, SourceCardMeta, ToolCategory, UntrustedKind } from '@spica/protocol';
import { humanError, isBalanceWords } from '../../../shared/errors';
import { AGENT_MESSAGES_LIMIT_MARK, askRecommended, PLAN_TOOL, readPlan, REPEAT_REMINDER_MARK, REPEAT_STOP_MARK, type PlanStep } from '@spica/protocol';
import { toolLabel } from '../chat/format';
import { N_, t, tx } from '../../../shared/i18n';
import { whenText } from '../schedule/model';
import { COMPUTER_ACCESS, computerCard, settleComputer, type ComputerBlock } from './computer-card';

export { humanError } from '../../../shared/errors';

export interface SuggestAction {
  label: string;
  prompt: string;
}

/**
 * unavailable: the tool was turned off (its plugin stopped); the core ran nothing.
 * timeout: waiting for sub-tasks gave up while they keep working (not a failure).
 * repeated: the same call came too many times in a row; the core did not run it (REPEAT_STOP_MARK).
 */
export type ToolState = 'pending' | 'running' | 'done' | 'error' | 'unavailable' | 'timeout' | 'repeated';

/** The core's answer to a call of a tool that was turned off (nothing was run). */
const UNAVAILABLE = /Tool "[^"]+" is no longer available/;
/** The core's answer when waiting for sub-tasks ran out of time; they are still working. */
const WAIT_TIMEOUT = /Stopped waiting \(timeout\)/;
function failedState(text: string | undefined): ToolState {
  if (text && UNAVAILABLE.test(text)) return 'unavailable';
  if (text?.includes(REPEAT_STOP_MARK)) return 'repeated';
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
      /** Its confirmation was allowed by the review, for the user (it is reviewed first): and the reason. */
      reviewAllowed?: ConfirmAnswer;
      /** Its confirmation is in review, in the background (no card yet). */
      asking?: ConfirmHandover;
      /** What kind of step it is, as the core said (tool.start, or the stored toolInfo); absent in older conversations. */
      category?: ToolCategory;
      /** The model's one line on what this step does (run_command's description). */
      summary?: string;
      /** A plugin tool's name for people. */
      title?: string;
      /** From an MCP service the person added: its name as written. */
      server?: string;
    }
  /** `cancelled`: the question was dropped unanswered (the run was stopped): nothing to answer any more. */
  /** `recommended`: the option the model suggests (marked 建议 on the card); none on older calls. */
  | { type: 'ask'; callId: string; question: string; options: string[]; recommended?: string; multiSelect?: boolean; answer?: string; cancelled?: boolean }
  /** `cancelled`: dropped undecided (the run was stopped): nothing to decide any more. */
  /** `irreversible`: what it allows cannot be undone (a plugin said so): the card shows 无法撤销. */
  /**
   * `delegated`: reviewed first; while in review there is no card (the call's row says so), handed back or with no
   * result the card is the user's. `by`: the review allowed it (there was never a card).
   */
  | { type: 'confirm'; callId: string; name: string; input: unknown; reason: string; approved?: boolean; cause?: GuardCause; cancelled?: boolean; irreversible?: boolean; change?: ChangePreview; outsideFolder?: string; folderTooWide?: boolean; keepTool?: boolean; install?: InstallPreview; delegated?: ConfirmHandover; by?: ConfirmAnswer }
  /** 操作电脑's approval card (computer_request_access): waiting and answered; the call has no step row. */
  | ComputerBlock
  | { type: 'suggest'; callId: string; title: string; actions: SuggestAction[] }
  /** An update_plan call: the whole list as it stands after it. `failed`: the core refused it (the plan before it stands). */
  | { type: 'plan'; callId: string; steps: PlanStep[]; failed?: boolean };

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
  if (typeof c.filesStayIn === 'string' && c.filesStayIn) return t('工作文件夹已选为 {to}，原来的文件留在 {folder}', { to: c.to, folder: c.filesStayIn });
  const moved = Array.isArray(c.moved) ? c.moved.length : 0;
  const renamed = Array.isArray(c.renamed) ? c.renamed : [];
  const files = moved ? t('，移入 {n} 个文件', { n: moved }) : '';
  const names = renamed.length ? t('，其中 {n} 个改了名：{names}', { n: renamed.length, names: renamed.map((r) => `${r.from} → ${r.to}`).join(t('、')) }) : '';
  return t('工作文件夹已选为 {to}{files}{names}', { to: c.to, files, names });
}

/** What a sub-agent that wrote nothing shows (its note's text is this key; translated where it is shown). */
export const NO_REPORT_WORDS = N_('无报告内容');

/**
 * A note's words in the current language: the notes the window words itself (a model switch, tools turned off,
 * the working folder) are worded again from their data where they are shown, so they follow 语言; other notes
 * are what was written. `text` keeps the words as they were when the note came.
 */
export function noteText(item: Extract<Item, { kind: 'note' }>): string {
  if (item.toolsOff) return t('工具已停用：{tools}', { tools: item.toolsOff.map((n) => toolLabel(n)).join(t('、')) });
  if (item.model) return item.model.from ? t('已切换模型：{from} → {to}', { from: item.model.from, to: item.model.to }) : t('已切换模型：{to}', { to: item.model.to });
  if (item.cwd) return cwdNoteText(item.cwd);
  return item.text === NO_REPORT_WORDS ? t(NO_REPORT_WORDS) : item.text;
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
  if (Array.isArray(gone) && gone.length) {
    const toolsOff = gone.map((n) => String(n));
    return { kind: 'note', id: m.id, text: noteText({ kind: 'note', id: m.id, text: '', toolsOff }), toolsOff };
  }
  // The user switched the conversation's model.
  const switched = m.meta?.modelChange as { from?: unknown; to?: unknown } | undefined;
  if (switched && typeof switched === 'object') {
    const from = modelOf(switched.from);
    const to = modelOf(switched.to);
    if (to) {
      const model = from ? { from, to } : { to };
      return { kind: 'note', id: m.id, text: noteText({ kind: 'note', id: m.id, text: '', model }), model };
    }
  }
  // The user chose the working folder; what the conversation had made moved there.
  const cwd = m.meta?.cwdChange;
  if (cwd && typeof cwd === 'object' && typeof cwd.to === 'string') return { kind: 'note', id: m.id, text: cwdNoteText(cwd), cwd };
  const child = childNoteOf(m);
  if (child) {
    const empty = child.kind === 'report' && (child.text.trim() === '' || child.text === NO_REPORT);
    return { kind: 'note', id: m.id, text: empty ? NO_REPORT_WORDS : child.text, child: empty ? { ...child, text: NO_REPORT_WORDS } : child };
  }
  const review = m.meta?.reviewNote;
  if (review && typeof review.fromSessionId === 'string') return { kind: 'note', id: m.id, text: '', review };
  if (m.meta?.author === 'runtime') return undefined;
  return { kind: 'note', id: m.id, text: textOf(m) };
}

/**
 * A run a 定时任务 started (meta.scheduleRun on the prompt the core sent): a line above it with the task and when it was
 * due (补跑 when it ran late: the app was closed or the computer asleep at that time).
 */
export function scheduleRunNote(m: Message): Item | undefined {
  const run = m.meta?.scheduleRun as { title?: unknown; dueAt?: unknown; late?: unknown } | undefined;
  if (!run || typeof run.title !== 'string' || typeof run.dueAt !== 'string') return undefined;
  const words = `${t('定时任务「{title}」', { title: run.title })} · ${whenText(run.dueAt, new Date())}${run.late === true ? ` · ${t('补跑')}` : ''}`;
  return { kind: 'note', id: `${m.id}:schedule`, text: words };
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
  /** `toolsOff`, `model`: the tools turned off, the model switch (noteText words them in the current language). */
  | { kind: 'note'; id: string; text: string; child?: ChildNote; review?: ReviewNoteMeta; cwd?: CwdChangeMeta; toolsOff?: string[]; model?: { from?: string; to: string } }
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
  /**
   * Where the error is put right: 'models' = 设置 › 模型 (a provider's 花费上限 was reached, or its account is out of
   * money); a button beside it opens it, at `errorProvider` when the stop said which.
   */
  errorAction?: 'models';
  /** A python_env download the user allowed failed in the last run: why (a notice above the input box). */
  installFailure?: InstallFailure;
  /** The provider whose 花费上限 stopped the run (from the budget.stop scope). */
  errorProvider?: string;
  /** The error is a 花费上限 stop: its period and when calls go again (errorText words it in the current language). */
  budget?: { periodDays?: number; resetAt?: string };
  /**
   * The last run stopped at a limit with the work not done (not an error): 'max_turns' (the turn limit; the desktop
   * app sets none since 2026-11-12, a script through the MCP service may). Shown as a note after the answer.
   */
  stopped?: 'max_turns' | 'repeated';
  /** stopped 'repeated': how many times in a row the same call came (the 8th was not run). */
  repeatCount?: number;
  /**
   * message_agent was refused since the user last wrote: this conversation reached its limit of messages to other
   * agents (设置 › 模型 › 代理互发消息上限). A note says so until the user writes again (the count starts over).
   */
  agentLimit?: boolean;
  /** The words of the last error the core marked retryable (a network error, 5xx, 429...): shown only if the run then ends in an error. */
  lastFailure?: string;
  /** Messages sent while a run was going, not yet taken in by the agent. */
  queued?: { id: string; text: string }[];
  /** File details the core reported (file.card), by call id: the call's first card. */
  fileCards?: Record<string, FileCardMeta>;
  /** Commands this conversation ran in the background (run_command with run_in_background), by id. */
  jobs?: Record<string, CommandJob>;
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
function aboutCall(e: { category?: ToolCategory; summary?: string; title?: string; server?: string }): { category?: ToolCategory; summary?: string; title?: string; server?: string } {
  return { ...(e.category ? { category: e.category } : {}), ...(e.summary ? { summary: e.summary } : {}), ...(e.title ? { title: e.title } : {}), ...(e.server ? { server: e.server } : {}) };
}

/** Tools that read or write a file; their `path` becomes a file card under the answer. */
export const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);
const ASK_TOOL = 'ask_user';
const SUGGEST_TOOL = 'suggest_actions';

/** The core's memory tools: shown as the 已记住 line, not in the group of steps. */
export const MEMORY_TOOLS = new Set(['remember', 'forget']);

/**
 * The 已记住 / 已更新 / 已忘记 line of a remember or forget call, as the item is now (`now`: the item in the
 * memory, with replaced and forgotten ones; null once deleted for good; undefined while not known). 撤销 only
 * while the change still stands; 已撤销 once it was undone; a change later deleted or replaced in the settings
 * keeps its words only.
 */
export function memoryLine(card: MemoryCardMeta, now: MemoryItem | null | undefined): { text: string; undo: boolean } | undefined {
  const item = card.item;
  if (!item) return undefined;
  const undone = card.action === 'forgotten' ? now?.status === 'active' : now?.undone === true;
  if (undone) return { text: t('已撤销：{text}', { text: item.text }), undo: false };
  // null: deleted for good in the settings (the words stay, nothing to undo); undefined: the memory is not loaded yet
  const stands = now === undefined || (now !== null && (card.action === 'forgotten' ? now.status === 'forgotten' : now.status === 'active'));
  if (card.action === 'replaced') return { text: card.previous ? t('已更新：{text}（替换「{old}」）', { text: item.text, old: card.previous.text }) : t('已更新：{text}', { text: item.text }), undo: stands };
  if (card.action === 'forgotten') return { text: t('已忘记：{text}', { text: item.text }), undo: stands };
  if (card.action === 'saved') return { text: t('已记住：{text}', { text: item.text }), undo: stands };
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

function asPlan(callId: string, input: unknown): Block {
  const { steps, error } = readPlan((input && typeof input === 'object' ? (input as { plan?: unknown }) : {}).plan);
  return { type: 'plan', callId, steps, ...(error ? { failed: true } : {}) };
}

/**
 * The conversation's plan: the steps of the latest update_plan call the core took (in the answers as they stand, not
 * replaced versions); `item`: the index of the item that holds it. None before the first call, or once cleared.
 */
export function currentPlan(t: Transcript): { callId: string; steps: PlanStep[]; item: number } | undefined {
  for (let i = t.items.length - 1; i >= 0; i--) {
    const it = t.items[i];
    if (it?.kind !== 'response') continue;
    for (let j = it.blocks.length - 1; j >= 0; j--) {
      const b = it.blocks[j];
      if (b?.type !== 'plan' || b.failed) continue;
      return b.steps.length ? { callId: b.callId, steps: b.steps, item: i } : undefined;
    }
  }
  return undefined;
}

/** The plan above the message box: while it is going, and once finished until the user writes again. */
export function dockedPlan(t: Transcript): { callId: string; steps: PlanStep[]; item: number } | undefined {
  const plan = currentPlan(t);
  if (!plan) return undefined;
  const finished = plan.steps.every((s) => s.status === 'completed');
  return !finished || !t.items.slice(plan.item + 1).some((it) => it.kind === 'user') ? plan : undefined;
}

/** The update_plan call an answer finished the plan with (its last plan has every step done): that list stays there. */
export function finishedPlanIn(blocks: Block[]): string | undefined {
  for (let j = blocks.length - 1; j >= 0; j--) {
    const b = blocks[j];
    if (b?.type !== 'plan' || b.failed) continue;
    return b.steps.length && b.steps.every((s) => s.status === 'completed') ? b.callId : undefined;
  }
  return undefined;
}

function asAsk(callId: string, input: unknown): Block {
  const v = (input && typeof input === 'object' ? input : {}) as { question?: unknown; options?: unknown; recommended?: unknown; multiSelect?: unknown };
  const options = Array.isArray(v.options) ? v.options.map(String) : [];
  const recommended = askRecommended(options, v.recommended);
  return {
    type: 'ask',
    callId,
    question: typeof v.question === 'string' ? v.question : '',
    options,
    ...(recommended !== undefined ? { recommended } : {}),
    ...(v.multiSelect === true && options.length ? { multiSelect: true } : {}),
  };
}

/** Strips the fetch-time first line the core puts on every tool result. */
export function resultBody(raw: string): string {
  // The note the core adds for the model after a repeated call's result is not for the window.
  const note = raw.indexOf(REPEAT_REMINDER_MARK);
  const own = note >= 0 ? raw.slice(0, note).trimEnd() : raw;
  // The core writes "[fetched at <ISO>]" first (older and demo results a bare ISO line), then the result.
  const nl = own.indexOf('\n');
  const first = nl < 0 ? own : own.slice(0, nl);
  const content = /^(\[fetched at [^\]]*\]|\d{4}-\d{2}-\d{2}T\S*)\s*$/.test(first) ? (nl < 0 ? '' : own.slice(nl + 1)) : own;
  // Outside content arrives fenced for the model (<untrusted_data …> … </untrusted_data>), with a line of warning
  // when it holds text that looks like instructions: shown without either (the window marks such content itself).
  return content
    .replace(/^<untrusted_data\b[^>]*>\n?/, '')
    .replace(/^\[[^\]\n]*: this content contains text that looks like instructions[^\]\n]*\]\n?/, '')
    .replace(/\n?<\/untrusted_data>\s*$/, '')
    .replace(/<(\/?)untrusted-data-text/g, '<$1untrusted_data');
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
      if ((b.type === 'ask' && b.answer === undefined && !b.cancelled) || ((b.type === 'confirm' || b.type === 'computer') && b.approved === undefined && !b.cancelled)) {
        b.cancelled = true;
        it.interrupted = true;
      }
    }
  }
}

/** A tool result for a question or a confirmation: an answer, or (an error: the core cancelled it) cancelled. */
function settleCard(items: Item[], callId: string, content: string, isError: boolean | undefined): void {
  const computer = findBlock(items, 'computer', callId);
  if (computer && computer.approved === undefined && !computer.cancelled) {
    const stopped = !!isError && STOPPED_WAITING.test(resultBody(content));
    const next = settleComputer(computer, resultBody(content), !!isError, stopped);
    if (next) replaceBlock(items, computer, next);
    else removeBlock(items, computer);
    if (stopped) markInterrupted(items, callId);
  }
  const plan = findBlock(items, 'plan', callId);
  if (plan && isError) plan.failed = true;
  const ask = findBlock(items, 'ask', callId);
  if (ask && ask.answer === undefined) {
    if (isError) {
      ask.cancelled = true;
      markInterrupted(items, callId);
    } else ask.answer = askAnswer(content);
  }
  const confirm = findBlock(items, 'confirm', callId);
  if (confirm && confirm.approved === undefined && isError && STOPPED_WAITING.test(resultBody(content))) {
    confirm.cancelled = true;
    markInterrupted(items, callId);
  }
}

/**
 * A confirmation card that is not drawn: in review (its call's row says so), or allowed by the review (there never was
 * a card). A card the user was shown (handed back, no result) is drawn, answered or not. One rule for the answer and
 * for what counts as its end (the status line, the live row).
 */
export function cardHiddenInReview(b: Block): boolean {
  return b.type === 'confirm' && b.delegated?.state === 'asking' && (!!b.by || (b.approved === undefined && !b.cancelled));
}

/** A call whose confirmation is in review says so on its row; handed back, its card says the rest. */
function markAsking(items: Item[], callId: string, delegated: ConfirmHandover | undefined): void {
  const tool = findBlock(items, 'tool', callId);
  if (!tool) return;
  if (delegated?.state === 'asking') tool.asking = delegated;
  else delete tool.asking;
}

/** What the core writes as the result of a question or confirmation dropped because the run was stopped. */
const STOPPED_WAITING = /^Cancelled\b/;

/** A block taken out. Mutates `items`. */
function removeBlock(items: Item[], old: Block): void {
  for (const it of items) {
    if (it.kind !== 'response') continue;
    const at = it.blocks.indexOf(old);
    if (at >= 0) {
      it.blocks.splice(at, 1);
      return;
    }
  }
}

/** `old` swapped for `next` where it stands. Mutates `items`. */
function replaceBlock(items: Item[], old: Block, next: Block): void {
  for (const it of items) {
    if (it.kind !== 'response') continue;
    const at = it.blocks.indexOf(old);
    if (at >= 0) {
      it.blocks[at] = next;
      return;
    }
  }
}

function markInterrupted(items: Item[], callId: string): void {
  const it = items.find((i) => i.kind === 'response' && i.blocks.some((b) => (b as { callId?: string }).callId === callId));
  if (it?.kind === 'response') it.interrupted = true;
}

/** The card `callId` marked cancelled (the core said it no longer waits on it). */
export function cancelCard(prev: Transcript, callId: string): Transcript {
  const t = clone(prev);
  for (const type of ['ask', 'confirm', 'computer'] as const) {
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
          else if (b.name === PLAN_TOOL) r.blocks.push(asPlan(b.id, b.input));
          else if (b.name === ASK_TOOL) r.blocks.push(asAsk(b.id, b.input));
          else if (b.name === COMPUTER_ACCESS) r.blocks.push(computerCard(b.id, b.input));
          else {
            // a call to a service the person added carries its name as written (stored with the call)
            const server = m.meta?.toolInfo?.[b.id]?.server;
            r.blocks.push({ type: 'tool', callId: b.id, name: b.name, input: b.input, state: 'done', ...(server ? { server } : {}) });
          }
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
        if (tool && b.isError && STOPPED_WAITING.test(resultBody(b.content))) {
          // A call that waited for 允许 when the run was stopped (the core writes "Cancelled: …" for nothing else):
          // it never ran. Back as the confirmation it was, 已中断, not a failed step. The model's own wording of
          // the step is not in the history: the title is the app's reading of the call.
          replaceBlock(items, tool, { type: 'confirm', callId: tool.callId, name: tool.name, input: tool.input, reason: '', cancelled: true });
          markInterrupted(items, b.toolUseId);
          continue;
        }
        if (tool) {
          const about = info?.[b.toolUseId];
          if (about?.category) tool.category = about.category;
          if (about?.summary) tool.summary = about.summary;
          if (about?.title) tool.title = about.title;
          if (about?.server) tool.server = about.server;
          tool.result = resultBody(b.content);
          tool.preview = tool.result.slice(0, 160);
          tool.state = b.isError ? failedState(b.content) : 'done';
          const note = m.meta?.guard?.[b.toolUseId];
          if (note) tool.outside = note.kind;
          if (note?.signals?.length) tool.flagged = note.kind;
          if (m.meta?.autoApproved?.includes(b.toolUseId)) tool.autoApproved = true;
          const answered = m.meta?.reviewAllowed?.[b.toolUseId];
          if (answered) tool.reviewAllowed = answered;
          continue;
        }
        settleCard(items, b.toolUseId, b.content, b.isError);
      }
      mark(m);
      continue;
    }
    const mailIds = mailIdsOf(m);
    if (mailIds) items.push(mailItem(m, mailIds));
    else if (m.kind === 'user' || m.kind === 'steer') {
      const run = scheduleRunNote(m);
      if (run) items.push(run);
      items.push(userItem(m));
    }
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
  if (refusedSinceUserWrote(messages)) t.agentLimit = true;
  const repeated = repeatStopSinceUserWrote(messages);
  if (repeated !== undefined) {
    t.stopped = 'repeated';
    t.repeatCount = repeated;
  }
  for (const p of pending) applyPending(t, p);
  // A question or confirmation with no result that the core no longer waits on was dropped (stopped before the
  // core wrote its result): nothing to answer.
  cancelOpenCards(t.items, new Set(pending.map((p) => p.callId)));
  return t;
}

/** How many times in a row, from the core's words (「came 8 times」, 「the 8th same」); 8 when they say none. */
function repeatCountIn(words: string): number {
  const m = /came (\d+) times|the (\d+)(?:st|nd|rd|th) same/.exec(words);
  return m ? Number(m[1] ?? m[2]) : 8;
}

/** A call not run for being the same call too often, after the last message the user typed: how many in a row. */
function repeatStopSinceUserWrote(messages: readonly Message[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && (m.kind === 'user' || m.kind === 'steer') && (m.meta?.author ?? 'user') === 'user') return undefined;
    for (const b of m.content) if (b.type === 'tool_result' && b.isError === true && b.content.includes(REPEAT_STOP_MARK)) return repeatCountIn(b.content);
  }
  return undefined;
}

/** A message_agent refused for the limit after the last message the user typed (AGENT_MESSAGES_LIMIT_MARK). */
function refusedSinceUserWrote(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && (m.kind === 'user' || m.kind === 'steer') && (m.meta?.author ?? 'user') === 'user') return false;
    if (m.content.some((b) => b.type === 'tool_result' && b.isError === true && b.content.includes(AGENT_MESSAGES_LIMIT_MARK))) return true;
  }
  return false;
}

function applyPending(t: Transcript, p: PendingItem): void {
  if (p.kind === 'ask') {
    const existing = findBlock(t.items, 'ask', p.callId);
    if (existing) {
      existing.question = p.question || existing.question;
      existing.options = p.options ?? existing.options;
      const recommended = askRecommended(existing.options, p.recommended ?? existing.recommended);
      if (recommended !== undefined) existing.recommended = recommended;
      else delete existing.recommended;
      if (p.multiSelect || existing.multiSelect) existing.multiSelect = true;
    } else {
      const options = p.options ?? [];
      const recommended = askRecommended(options, p.recommended);
      lastResponse(t.items, `pending-${p.callId}`).blocks.push({ type: 'ask', callId: p.callId, question: p.question, options, ...(recommended !== undefined ? { recommended } : {}), ...(p.multiSelect ? { multiSelect: true } : {}) });
    }
  } else {
    // The call is stored with its message before it is asked about, with no result yet: it has not run. Waiting
    // (as it shows live), not done; done comes with its result once it was allowed and ran.
    const call = findBlock(t.items, 'tool', p.callId);
    if (call && call.result === undefined) call.state = 'pending';
    if (p.toolName === COMPUTER_ACCESS) {
      // the card as asked (the programs the main process worked out), in place of the one made from the history
      const card = computerCard(p.callId, p.input);
      const was = findBlock(t.items, 'computer', p.callId);
      if (was) replaceBlock(t.items, was, card);
      else lastResponse(t.items, `pending-${p.callId}`).blocks.push(card);
    } else {
      markAsking(t.items, p.callId, p.delegated);
      const card = findBlock(t.items, 'confirm', p.callId);
      if (card) {
        if (p.delegated) card.delegated = p.delegated;
      } else
        lastResponse(t.items, `pending-${p.callId}`).blocks.push({ type: 'confirm', callId: p.callId, name: p.toolName, input: p.input, reason: p.reason, ...(p.cause ? { cause: p.cause } : {}), ...(p.irreversible ? { irreversible: true } : {}), ...(p.change ? { change: p.change } : {}), ...(p.outsideFolder ? { outsideFolder: p.outsideFolder } : {}), ...(p.folderTooWide ? { folderTooWide: true } : {}), ...(p.keepTool ? { keepTool: true } : {}), ...(p.install ? { install: p.install } : {}), ...(p.delegated ? { delegated: p.delegated } : {}) });
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
        if (!items.some((i) => i.id === m.id)) {
          const run = scheduleRunNote(m);
          if (run) items.push(run);
          items.push(userItem(m));
        }
        if (t.queued?.some((q) => q.id === m.id)) t.queued = t.queued.filter((q) => q.id !== m.id);
        // the user wrote: the count of messages to other agents starts over
        if ((m.meta?.author ?? 'user') === 'user') delete t.agentLimit;
      } else if (m.role === 'user' && (m.kind === 'relay' || m.kind === 'report' || m.kind === 'note')) {
        const note = items.some((i) => i.id === m.id) ? undefined : noteItem(m);
        if (note) items.push(note);
      } else if (m.role === 'assistant' && m.meta?.interrupted === true) {
        lastResponse(items, respId).interrupted = true;
      } else if (m.role === 'assistant' && m.kind === 'assistant') {
        const r = lastResponse(items, respId);
        r.truncated = m.meta?.stopReason === 'max_tokens';
        // A call announced while the model wrote (tool.call) that its finished message does not carry was never
        // made: cut off at the length limit, or streamed again under another id. Its placeholder would turn for
        // the rest of the run.
        const made = new Set(m.content.flatMap((c) => (c.type === 'tool_use' ? [c.id] : [])));
        r.blocks = r.blocks.filter((x) => !(x.type === 'tool' && x.state === 'pending' && !made.has(x.callId)));
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
      if (e.name === ASK_TOOL || e.name === SUGGEST_TOOL || e.name === PLAN_TOOL || e.name === COMPUTER_ACCESS) return t;
      if (findBlock(items, 'tool', e.callId)) return t;
      lastResponse(items, respId).blocks.push({ type: 'tool', callId: e.callId, name: e.name, input: undefined, state: 'pending', ...(e.server ? { server: e.server } : {}) });
      return t;
    }
    case 'tool.start': {
      if (e.name === SUGGEST_TOOL) {
        if (!findBlock(items, 'suggest', e.callId)) lastResponse(items, respId).blocks.push(asSuggest(e.callId, e.input));
        return t;
      }
      if (e.name === PLAN_TOOL) {
        if (!findBlock(items, 'plan', e.callId)) lastResponse(items, respId).blocks.push(asPlan(e.callId, e.input));
        return t;
      }
      if (e.name === ASK_TOOL || e.name === COMPUTER_ACCESS) return t;
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
      // the approval card: 始终允许 when its result says so (the preview may be cut before it: never taken as 允许一次)
      const card = e.name === COMPUTER_ACCESS ? findBlock(items, 'computer', e.callId) : undefined;
      if (card && !e.isError && /for every conversation/.test(e.preview)) card.always = true;
      const plan = findBlock(items, 'plan', e.callId);
      if (plan && e.isError) plan.failed = true;
      const tool = findBlock(items, 'tool', e.callId);
      if (tool) {
        tool.state = e.isError ? failedState(e.preview) : 'done';
        tool.preview = e.preview;
        tool.durationMs = e.durationMs;
      }
      if (e.name === 'message_agent' && e.isError && e.preview.includes(AGENT_MESSAGES_LIMIT_MARK)) t.agentLimit = true;
      return t;
    }
    case 'confirm.request': {
      if (e.name === COMPUTER_ACCESS) {
        if (!findBlock(items, 'computer', e.callId)) lastResponse(items, respId).blocks.push(computerCard(e.callId, e.input));
        return t;
      }
      markAsking(items, e.callId, e.delegated);
      const asked = findBlock(items, 'confirm', e.callId);
      // asked again: the review handed it back or gave no result, and the card is shown now
      if (asked) {
        if (e.delegated) asked.delegated = e.delegated;
      } else {
        lastResponse(items, respId).blocks.push({ type: 'confirm', callId: e.callId, name: e.name, input: e.input, reason: e.reason, ...(e.cause ? { cause: e.cause } : {}), ...(e.irreversible ? { irreversible: true } : {}), ...(e.change ? { change: e.change } : {}), ...(e.outsideFolder ? { outsideFolder: e.outsideFolder } : {}), ...(e.folderTooWide ? { folderTooWide: true } : {}), ...(e.keepTool ? { keepTool: true } : {}), ...(e.install ? { install: e.install } : {}), ...(e.delegated ? { delegated: e.delegated } : {}) });
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
      const c = findBlock(items, 'confirm', e.callId) ?? findBlock(items, 'computer', e.callId);
      if (c) c.approved = e.approved;
      if (c?.type === 'confirm' && e.by) {
        c.by = e.by;
        // the step's row says who allowed it, as it does once the conversation is opened again
        const tool = findBlock(items, 'tool', e.callId);
        if (tool) tool.reviewAllowed = e.by;
      }
      markAsking(items, e.callId, undefined);
      return t;
    }
    case 'install.failed': {
      // a download the user allowed failed: why, above the input box until the next run starts (not kept in history)
      t.installFailure = e.failure;
      return t;
    }
    case 'ask.request': {
      const existing = findBlock(items, 'ask', e.callId);
      if (existing) {
        existing.question = e.question;
        existing.options = e.options ?? [];
        const recommended = askRecommended(existing.options, e.recommended);
        if (recommended !== undefined) existing.recommended = recommended;
        else delete existing.recommended;
        if (e.multiSelect) existing.multiSelect = true;
        else delete existing.multiSelect;
        delete existing.cancelled;
      } else {
        const options = e.options ?? [];
        const recommended = askRecommended(options, e.recommended);
        lastResponse(items, respId).blocks.push({ type: 'ask', callId: e.callId, question: e.question, options, ...(recommended !== undefined ? { recommended } : {}), ...(e.multiSelect ? { multiSelect: true } : {}) });
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
        // a new run (not the next step of this one): a failed download from the last one is old news
        if (!t.run) delete t.installFailure;
        const startedAt = t.run?.startedAt ?? now;
        t.run = { startedAt, status: e.status, ...(e.detail ? { detail: e.detail } : {}) };
        delete t.error;
        delete t.errorAction;
        delete t.errorProvider;
        delete t.budget;
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
      else showError(t, words);
      return t;
    }
    case 'run.end': {
      if (e.reason === 'error' && !t.error) {
        const words = t.lastFailure ?? (e.detail ? humanError(e.detail) : undefined);
        if (words) showError(t, words);
      }
      delete t.lastFailure;
      if (e.reason === 'max_turns') t.stopped = 'max_turns';
      if (e.reason === 'repeated') {
        t.stopped = 'repeated';
        t.repeatCount = repeatCountIn(e.detail ?? '');
      }
      return t;
    }
    case 'budget.stop': {
      t.error = budgetStopWords(e.periodDays, e.resetAt);
      t.budget = { ...(e.periodDays !== undefined ? { periodDays: e.periodDays } : {}), ...(e.resetAt !== undefined ? { resetAt: e.resetAt } : {}) };
      t.errorAction = 'models';
      // 「<providerId>:global」: that provider's 花费上限 (other scopes come from scripts' limits)
      const provider = e.scope.slice(0, e.scope.lastIndexOf(':'));
      if (provider && provider !== 'all') t.errorProvider = provider;
      return t;
    }
    case 'command.job': {
      t.jobs = { ...(t.jobs ?? {}), [e.job.id]: e.job };
      return t;
    }
    default:
      return t;
  }
}

/**
 * The conversation's background commands as the core listed them; the files each changed (known when it ended)
 * become its run_command call's cards, as they do live (file.card), so they are there after a restart too.
 */
export function withJobs(t: Transcript, jobs: readonly CommandJob[]): Transcript {
  if (!jobs.length) return t;
  const next: Transcript = { ...t, jobs: { ...(t.jobs ?? {}) } };
  for (const j of jobs) {
    next.jobs![j.id] = j;
    if (j.files?.length && !next.fileCards?.[j.callId]) {
      next.fileCards = { ...(next.fileCards ?? {}), [j.callId]: j.files[0]! };
      next.fileCardLists = { ...(next.fileCardLists ?? {}), [j.callId]: j.files };
    }
  }
  return next;
}

/**
 * A spending limit stopped the run: one short line, which period it was and when calls go again (the amounts are in
 * 设置 › 模型, a button opens it): 「已达 7 天花费上限，11/20 14:05 恢复」.
 */
export function budgetStopWords(periodDays?: number, resetAt?: string): string {
  const at = resetAt ? new Date(resetAt) : null;
  if (!periodDays || !at || Number.isNaN(at.getTime())) return t('已达花费上限');
  const p = (n: number) => String(n).padStart(2, '0');
  return t('已达 {n} 天花费上限，{time} 恢复', { n: periodDays, time: `${at.getMonth() + 1}/${at.getDate()} ${p(at.getHours())}:${p(at.getMinutes())}` });
}

/**
 * The conversation's error in the current language: a 花费上限 stop is worded again from its data; other errors
 * were worded when they came (in Simplified, or the hint's words) and are looked up as they are.
 */
export function errorText(tr: Transcript): string {
  if (!tr.error) return '';
  return tr.budget ? budgetStopWords(tr.budget.periodDays, tr.budget.resetAt) : tx(tr.error);
}

/** An error as the conversation shows it; the provider's account out of money also gets the button to 设置 › 模型. */
function showError(tr: Transcript, words: string): void {
  tr.error = words;
  delete tr.budget;
  if (isBalanceWords(words)) tr.errorAction = 'models';
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
  // a file the result carried that was not kept: why (an MCP tool's embedded file)
  if (f.card?.notSaved) return `Not saved · ${NOT_SAVED[f.card.notSaved]}`;
  const origin = f.card?.origin;
  const command = f.category === 'command' || f.tool === 'run_command';
  if (origin === 'created') return command ? 'Created while the command ran' : 'Created';
  if (origin === 'modified') return command ? 'Changed while the command ran' : 'Edited';
  if (origin === 'produced') return 'Made';
  return null;
}

const NOT_SAVED: Record<NonNullable<FileCardMeta['notSaved']>, string> = { too_large: 'over 50 MB', bad_data: 'invalid data', write_failed: 'write failed', no_folder: 'no folder' };

const KIND_LABEL: Record<FileCardMeta['kind'], string> = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel', csv: 'CSV', pptx: 'PPT', text: N_('文本'), other: N_('文件') };

/** One line under the file name: what kind, how big, what was read, and anything to watch out for. */
export function fileCardLine(card: FileCardMeta): string {
  const { kind, read } = fileCardParts(card);
  return read ? `${kind} · ${read}` : kind;
}

/** The two halves of fileCardLine: what the file is (PDF · 4 页) and what was read of it (Read pages 1-3). */
export function fileCardParts(card: FileCardMeta): { kind: string; read: string } {
  // a picture: 图片 · 1920×1080 (its size as the file is)
  const kind: string[] = [card.image ? t('图片') : KIND_LABEL[card.kind] ? t(KIND_LABEL[card.kind]) : card.kind];
  if (card.image) kind.push(`${card.image.width}×${card.image.height}`);
  if (card.pageCount) kind.push(t('{n} 页', { n: card.pageCount }));
  if (card.sheets?.length) kind.push(t('{n} 个表', { n: card.sheets.length }));
  if (card.slideCount) kind.push(t('{n} 页幻灯片', { n: card.slideCount }));
  const parts: string[] = [];
  const r = card.read;
  const sheetsRead = r.sheet ? r.sheet.split(/,\s*/).filter(Boolean) : [];
  const wholeFile =
    (r.pages !== undefined && card.pageCount !== undefined && (r.pages === `1-${card.pageCount}` || (card.pageCount === 1 && r.pages === '1'))) ||
    (card.sheets !== undefined && sheetsRead.length === card.sheets.length && !r.rows && !r.range);
  // What was done with it in English, like the tool lines (Read, Read pages 1-3); what the file is stays Chinese.
  if (wholeFile && !card.truncated) parts.push('Read');
  else if (r.pages) parts.push(/[-,]/.test(r.pages) ? `Read pages ${r.pages}` : `Read page ${r.pages}`);
  else if (r.sheet) {
    const names = sheetsRead.map((n) => t('「{name}」', { name: n })).join(', ');
    parts.push(`Read ${names}${r.range ? ` ${r.range}` : r.rows ? ` rows ${r.rows}` : ''}`);
  }
  else if (r.range) parts.push(`Read ${r.range}`);
  else if (r.rows) parts.push(`Read rows ${r.rows}`);
  if (card.noTextLayer) parts.push(t('扫描件，无法读取文字'));
  else if (card.truncated) parts.push('Partly read');
  return { kind: kind.join(' · '), read: parts.join(' · ') };
}
