// Turns a session's history (Message[] + pending items) and its live event
// stream into what the conversation view draws. Pure functions, no React.
import type { CoreEvent, Message, PendingItem, SessionStatus } from '@spica/protocol';

export interface SuggestAction {
  label: string;
  prompt: string;
}

export type ToolState = 'pending' | 'running' | 'done' | 'error';

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
    }
  | { type: 'ask'; callId: string; question: string; options: string[]; answer?: string }
  | { type: 'confirm'; callId: string; name: string; input: unknown; reason: string; approved?: boolean }
  | { type: 'suggest'; callId: string; title: string; actions: SuggestAction[] };

export type Item =
  | { kind: 'user'; id: string; text: string; steer: boolean }
  | { kind: 'note'; id: string; text: string }
  | { kind: 'response'; id: string; blocks: Block[]; interrupted: boolean };

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
  /** Messages sent while a run was going, not yet taken in by the agent. */
  queued?: { id: string; text: string }[];
}

export const EMPTY_TRANSCRIPT: Transcript = { items: [] };

/** Tools that read or write a file; their `path` becomes a file card under the answer. */
export const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);
const ASK_TOOL = 'ask_user';
const SUGGEST_TOOL = 'suggest_actions';

function textOf(message: Message): string {
  return message.content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'opaque' ? (b.text ?? '') : ''))
    .join('');
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
export function resultBody(content: string): string {
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
export function fromHistory(messages: readonly Message[], pending: readonly PendingItem[] = []): Transcript {
  const items: Item[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const r = lastResponse(items, m.id);
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
      continue;
    }
    if (m.kind === 'tool_results') {
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        const tool = findBlock(items, 'tool', b.toolUseId);
        if (tool) {
          tool.result = resultBody(b.content);
          tool.preview = tool.result.slice(0, 160);
          tool.state = b.isError ? 'error' : 'done';
          continue;
        }
        const ask = findBlock(items, 'ask', b.toolUseId);
        if (ask) ask.answer = askAnswer(b.content);
      }
      continue;
    }
    const text = textOf(m);
    if (m.kind === 'user' || m.kind === 'steer') items.push({ kind: 'user', id: m.id, text, steer: m.kind === 'steer' });
    else items.push({ kind: 'note', id: m.id, text });
  }
  const t: Transcript = { items };
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
      lastResponse(t.items, `pending-${p.callId}`).blocks.push({ type: 'confirm', callId: p.callId, name: p.toolName, input: p.input, reason: p.reason });
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
      if (m.role === 'user' && (m.kind === 'user' || m.kind === 'steer')) {
        if (!items.some((i) => i.id === m.id)) items.push({ kind: 'user', id: m.id, text: textOf(m), steer: m.kind === 'steer' });
        if (t.queued?.some((q) => q.id === m.id)) t.queued = t.queued.filter((q) => q.id !== m.id);
      } else if (m.role === 'user' && (m.kind === 'relay' || m.kind === 'report' || m.kind === 'note')) {
        if (!items.some((i) => i.id === m.id)) items.push({ kind: 'note', id: m.id, text: textOf(m) });
      } else if (m.role === 'assistant' && m.meta?.interrupted === true) {
        lastResponse(items, respId).interrupted = true;
      }
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
    case 'tool.end': {
      const tool = findBlock(items, 'tool', e.callId);
      if (tool) {
        tool.state = e.isError ? 'error' : 'done';
        tool.preview = e.preview;
        tool.durationMs = e.durationMs;
      }
      return t;
    }
    case 'confirm.request': {
      if (!findBlock(items, 'confirm', e.callId)) {
        lastResponse(items, respId).blocks.push({ type: 'confirm', callId: e.callId, name: e.name, input: e.input, reason: e.reason });
      }
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
      // Retries are the core's business; only a final error reaches the user.
      if (!e.retryable) t.error = humanError(e.message);
      return t;
    }
    case 'budget.stop': {
      t.error = `花费到上限了，已停下（已花 ${formatMoney(e.spentUsd)}，上限 ${formatMoney(e.limitUsd)}）。`;
      return t;
    }
    default:
      return t;
  }
}

function formatMoney(usd: number): string {
  return 'US$' + usd.toFixed(2);
}

/** Turns a raw backend error into a sentence the user can act on. */
export function humanError(raw: string): string {
  const m = raw.toLowerCase();
  if (/\b401\b|unauthori[sz]ed|invalid api key|authentication/.test(m)) return '模型密钥不对或已失效，请检查模型设置。';
  if (/\b403\b|forbidden/.test(m)) return '这个模型账号没有权限，请检查模型设置。';
  if (/\b404\b|model_not_found|does not exist/.test(m)) return '找不到这个模型，请检查模型名称。';
  if (/\b429\b|rate limit|too many requests/.test(m)) return '模型接口太忙（被限流了），稍后再试。';
  if (/insufficient|balance|quota|credit/.test(m)) return '模型账号余额不足。';
  if (/\b5\d\d\b|overloaded|bad gateway|service unavailable/.test(m)) return '模型服务暂时出错了，稍后再试。';
  if (/timeout|timed out|etimedout/.test(m)) return '模型接口太久没有回应，稍后再试。';
  if (/fetch failed|econnrefused|enotfound|network|socket/.test(m)) return '连不上模型接口，请检查网络或接口地址。';
  if (/unknown provider/.test(m)) return '还没有配置这个模型。';
  return `出错了：${raw}`;
}

/** Files the answer touched, in first-seen order. */
export function filesOf(blocks: readonly Block[]): { path: string; tool: string }[] {
  const seen = new Map<string, string>();
  for (const b of blocks) {
    if (b.type !== 'tool' || !FILE_TOOLS.has(b.name) || b.state === 'error') continue;
    const path = (b.input as { path?: unknown } | undefined)?.path;
    if (typeof path === 'string' && !seen.has(path)) seen.set(path, b.name);
  }
  return [...seen].map(([path, tool]) => ({ path, tool }));
}
