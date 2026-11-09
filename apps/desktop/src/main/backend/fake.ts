// A scripted stand-in for @spica/core. It implements the same AgentApi and
// emits the same CoreEvent stream (docs/design/agent-core.md §4), so every
// screen can be built, tested and screenshotted before the real core exists.
// It never touches the network or the disk.
import type {
  AgentRole,
  ContentBlock,
  CoreEvent,
  CoreEventBody,
  CreateSessionRequest,
  Message,
  MessageKind,
  PendingItem,
  SendResult,
  SessionInfo,
  SessionStatus,
  SteerMode,
} from '@spica/protocol';
import type { AgentBackend } from './types';
import { buildSeed } from './fake-seed';
import { isoAt } from './time';

export interface FakeBackendOptions {
  /** Multiplies every delay; 0 runs scripts instantly (tests). Default 1. */
  speed?: number;
  /** Start with the demo projects and history. Default true. */
  seed?: boolean;
  /** Clock, for deterministic screenshots and tests. */
  now?: () => Date;
}

type Listener = (event: CoreEvent) => void;

interface Waiter {
  callId: string;
  resolve: (value: string) => void;
}

interface Run {
  controller: AbortController;
  steers: Message[];
  waiter?: Waiter;
}

class Aborted extends Error {}

/** Splits text into small chunks the way a model stream arrives. */
export function chunk(text: string, size = 3): string[] {
  const out: string[] = [];
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

export class FakeBackend implements AgentBackend {
  readonly #speed: number;
  readonly #now: () => Date;
  #seq = 0;
  #ids = 0;
  #listeners = new Set<Listener>();
  #sessions = new Map<string, SessionInfo>();
  #messages = new Map<string, Message[]>();
  #pending = new Map<string, PendingItem[]>();
  #runs = new Map<string, Run>();
  #globalCost = 0;

  constructor(options: FakeBackendOptions = {}) {
    this.#speed = options.speed ?? 1;
    this.#now = options.now ?? (() => new Date());
    if (options.seed ?? true) {
      const seed = buildSeed(this.#now());
      for (const s of seed.sessions) this.#sessions.set(s.id, s);
      for (const [id, list] of Object.entries(seed.messages)) this.#messages.set(id, list);
      for (const [id, list] of Object.entries(seed.pending)) this.#pending.set(id, list);
      this.#ids = 1000;
    }
  }

  // ----- events -------------------------------------------------------------

  onEvent(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(sessionId: string, body: CoreEventBody): void {
    const session = this.#sessions.get(sessionId);
    const event = {
      ...body,
      seq: ++this.#seq,
      at: isoAt(this.#now()),
      sessionId,
      parentChain: session?.parentChain ?? [],
    } as CoreEvent;
    for (const l of this.#listeners) {
      try {
        l(event);
      } catch {
        // A broken consumer must not stop the script.
      }
    }
  }

  #id(prefix: string): string {
    return `${prefix}-${++this.#ids}`;
  }

  #setStatus(sessionId: string, status: SessionStatus, detail?: string): void {
    const s = this.#sessions.get(sessionId);
    if (!s) return;
    s.status = status;
    s.updatedAt = isoAt(this.#now());
    this.#emit(sessionId, detail ? { type: 'status', status, detail } : { type: 'status', status });
  }

  #append(sessionId: string, role: 'user' | 'assistant', kind: MessageKind, content: ContentBlock[], meta?: Record<string, unknown>): Message {
    const list = this.#messages.get(sessionId) ?? [];
    const message: Message = {
      id: this.#id('m'),
      sessionId,
      seq: list.length + 1,
      role,
      kind,
      content,
      createdAt: isoAt(this.#now()),
      ...(meta ? { meta } : {}),
    };
    list.push(message);
    this.#messages.set(sessionId, list);
    this.#emit(sessionId, { type: 'message', message });
    return message;
  }

  // ----- AgentApi -----------------------------------------------------------

  async createSession(req: CreateSessionRequest): Promise<SessionInfo> {
    const parent = req.parentId ? this.#sessions.get(req.parentId) : undefined;
    const at = isoAt(this.#now());
    const role: AgentRole = req.role ?? (parent ? 'worker' : 'top');
    const info: SessionInfo = {
      id: this.#id('s'),
      parentId: parent?.id ?? null,
      parentChain: parent ? [parent.id, ...parent.parentChain] : [],
      role,
      title: req.title ?? null,
      status: 'idle',
      providerId: req.providerId ?? 'fake',
      model: req.model ?? 'fake-model',
      cwd: req.cwd ?? parent?.cwd ?? '',
      costUsd: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.#sessions.set(info.id, info);
    this.#messages.set(info.id, []);
    if (parent) this.#emit(parent.id, { type: 'child.spawned', childId: info.id, title: info.title });
    return structuredClone(info);
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.#sessions.values()].map((s) => structuredClone(s));
  }

  async getSession(sessionId: string): Promise<SessionInfo | undefined> {
    const s = this.#sessions.get(sessionId);
    return s ? structuredClone(s) : undefined;
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    return structuredClone(this.#messages.get(sessionId) ?? []);
  }

  async getPending(sessionId: string): Promise<PendingItem[]> {
    return structuredClone(this.#pending.get(sessionId) ?? []);
  }

  async send(sessionId: string, text: string): Promise<SendResult> {
    this.#requireSession(sessionId);
    const run = this.#runs.get(sessionId);
    if (run) return this.steer(sessionId, text, 'next');
    const message = this.#append(sessionId, 'user', 'user', [{ type: 'text', text }], { author: 'user' });
    void this.#run(sessionId, text);
    return { messageId: message.id, started: true };
  }

  async steer(sessionId: string, text: string, mode: SteerMode): Promise<SendResult> {
    this.#requireSession(sessionId);
    const run = this.#runs.get(sessionId);
    if (!run) return this.send(sessionId, text);
    const message: Message = {
      id: this.#id('m'),
      sessionId,
      seq: 0,
      role: 'user',
      kind: 'steer',
      content: [{ type: 'text', text }],
      createdAt: isoAt(this.#now()),
      meta: { author: 'user' },
    };
    run.steers.push(message);
    this.#emit(sessionId, { type: 'steer.queued', messageId: message.id, mode });
    return { messageId: message.id, started: false };
  }

  async renameSession(sessionId: string, title: string | null): Promise<SessionInfo> {
    const s = this.#requireSession(sessionId);
    s.title = title?.trim() ? title.trim() : null;
    s.updatedAt = isoAt(this.#now());
    this.#emit(sessionId, { type: 'session.renamed', title: s.title });
    return structuredClone(s);
  }

  async resume(sessionId: string): Promise<void> {
    const s = this.#requireSession(sessionId);
    if (s.status !== 'interrupted' || this.#runs.has(sessionId)) return;
    void this.#run(sessionId, '', { resumeWith: '继续上次的' });
  }

  async answer(sessionId: string, callId: string, answer: string): Promise<void> {
    this.#resolvePending(sessionId, callId, answer);
    this.#emit(sessionId, { type: 'ask.resolved', callId, answer });
  }

  async confirm(sessionId: string, callId: string, approved: boolean): Promise<void> {
    this.#resolvePending(sessionId, callId, approved ? 'yes' : 'no');
    this.#emit(sessionId, { type: 'confirm.resolved', callId, approved });
  }

  async abort(sessionId: string): Promise<void> {
    this.#runs.get(sessionId)?.controller.abort();
  }

  async exportTraces(): Promise<string> {
    return '';
  }

  dispose(): void {
    for (const run of this.#runs.values()) run.controller.abort();
    this.#runs.clear();
    this.#listeners.clear();
  }

  // ----- script -------------------------------------------------------------

  #requireSession(sessionId: string): SessionInfo {
    const s = this.#sessions.get(sessionId);
    if (!s) throw new Error(`找不到这个会话（${sessionId}）`);
    return s;
  }

  #resolvePending(sessionId: string, callId: string, value: string): void {
    const list = this.#pending.get(sessionId) ?? [];
    this.#pending.set(
      sessionId,
      list.filter((p) => p.callId !== callId),
    );
    const run = this.#runs.get(sessionId);
    if (run?.waiter?.callId === callId) {
      const w = run.waiter;
      run.waiter = undefined;
      w.resolve(value);
    } else if (!run) {
      // Pending from history (e.g. after a restart): resume with a short follow-up.
      const s = this.#sessions.get(sessionId);
      if (s && (s.status === 'awaiting_answer' || s.status === 'awaiting_confirm')) {
        void this.#run(sessionId, '', { resumeWith: value });
      }
    }
  }

  #sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Aborted());
    const wait = ms * this.#speed;
    if (wait <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, wait);
      const onAbort = () => {
        clearTimeout(t);
        reject(new Aborted());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #waitFor(run: Run, callId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      run.waiter = { callId, resolve };
      run.controller.signal.addEventListener('abort', () => reject(new Aborted()), { once: true });
    });
  }

  async #stream(sessionId: string, kind: 'text' | 'thinking', text: string, signal: AbortSignal): Promise<void> {
    for (const piece of chunk(text, kind === 'thinking' ? 6 : 3)) {
      await this.#sleep(kind === 'thinking' ? 30 : 22, signal);
      this.#emit(sessionId, kind === 'text' ? { type: 'text.delta', delta: piece } : { type: 'thinking.delta', delta: piece });
    }
  }

  #applySteers(sessionId: string, run: Run): void {
    if (run.steers.length === 0) return;
    const list = this.#messages.get(sessionId) ?? [];
    const ids: string[] = [];
    for (const m of run.steers) {
      m.seq = list.length + 1;
      list.push(m);
      ids.push(m.id);
      this.#emit(sessionId, { type: 'message', message: m });
    }
    run.steers = [];
    this.#emit(sessionId, { type: 'steer.applied', messageIds: ids });
  }

  async #tool(sessionId: string, run: Run, name: string, input: unknown, result: string, ms: number): Promise<ContentBlock[]> {
    const callId = this.#id('call');
    this.#emit(sessionId, { type: 'tool.call', callId, name });
    this.#emit(sessionId, { type: 'tool.start', callId, name, input });
    this.#setStatus(sessionId, 'tool', name);
    await this.#sleep(ms, run.controller.signal);
    const content = `${isoAt(this.#now())}\n${result}`;
    this.#emit(sessionId, { type: 'tool.end', callId, name, isError: false, preview: result.slice(0, 160), durationMs: ms });
    return [
      { type: 'tool_use', id: callId, name, input },
      { type: 'tool_result', toolUseId: callId, content },
    ];
  }

  #charge(sessionId: string, inputTokens: number, outputTokens: number): void {
    const costUsd = (inputTokens * 0.27 + outputTokens * 1.1) / 1_000_000;
    const s = this.#sessions.get(sessionId);
    if (s) s.costUsd += costUsd;
    this.#globalCost += costUsd;
    this.#emit(sessionId, { type: 'usage', usage: { inputTokens, outputTokens }, costUsd, providerId: 'fake', model: 'fake-model' });
    this.#emit(sessionId, { type: 'cost', scope: 'session', spentUsd: s?.costUsd ?? costUsd, warning: false });
    this.#emit(sessionId, { type: 'cost', scope: 'global', spentUsd: this.#globalCost, limitUsd: 100, warning: false });
  }

  /** Commits one assistant message made of the blocks streamed so far. */
  #commitAssistant(sessionId: string, blocks: ContentBlock[]): void {
    const own = blocks.filter((b) => b.type !== 'tool_result');
    const results = blocks.filter((b) => b.type === 'tool_result');
    if (own.length) this.#append(sessionId, 'assistant', 'assistant', own);
    if (results.length) this.#append(sessionId, 'user', 'tool_results', results, { author: 'runtime' });
    blocks.length = 0;
  }

  async #run(sessionId: string, text: string, opts: { resumeWith?: string } = {}): Promise<void> {
    const run: Run = { controller: new AbortController(), steers: [] };
    this.#runs.set(sessionId, run);
    const signal = run.controller.signal;
    const blocks: ContentBlock[] = [];
    let turn = 0;
    try {
      this.#setStatus(sessionId, 'thinking');
      this.#emit(sessionId, { type: 'turn.start', turn: ++turn });

      if (opts.resumeWith !== undefined) {
        const reply = `好的，按「${opts.resumeWith}」继续。纪要初稿已经按这个口径整理好了。`;
        await this.#stream(sessionId, 'text', reply, signal);
        blocks.push({ type: 'text', text: reply });
        this.#commitAssistant(sessionId, blocks);
        this.#charge(sessionId, 1800, 120);
        this.#emit(sessionId, { type: 'turn.end', turn });
        this.#finish(sessionId, 'completed');
        return;
      }

      const thinking = `用户说「${text.slice(0, 40)}」。先看一眼工作文件夹里有什么，再决定怎么回答。`;
      await this.#sleep(400, signal);
      await this.#stream(sessionId, 'thinking', thinking, signal);
      blocks.push({ type: 'thinking', text: thinking });

      const intro = '我先看一下工作文件夹里的资料。';
      this.#setStatus(sessionId, 'thinking');
      await this.#stream(sessionId, 'text', intro, signal);
      blocks.push({ type: 'text', text: intro });

      blocks.push(
        ...(await this.#tool(sessionId, run, 'list_dir', { path: '.' }, '会议记录/\n报价单.xlsx\n测试报告.pdf\n需求说明.docx', 500)),
      );
      blocks.push(
        ...(await this.#tool(
          sessionId,
          run,
          'read_file',
          { path: '需求说明.docx' },
          '需求说明 v3：外壳尺寸 120×80×24 mm；续航不少于 10 小时；首批样机 20 台，月底前交付。',
          700,
        )),
      );
      this.#commitAssistant(sessionId, blocks);
      this.#charge(sessionId, 2400, 180);
      this.#emit(sessionId, { type: 'turn.end', turn });
      this.#applySteers(sessionId, run);

      this.#emit(sessionId, { type: 'turn.start', turn: ++turn });
      this.#setStatus(sessionId, 'thinking');
      await this.#sleep(300, signal);

      if (/确认|发送|发给/.test(text)) {
        const callId = this.#id('call');
        const input = { to: '项目组', subject: '样机评审时间', body: '各位好，样机评审定在周四下午两点。' };
        const lead = '我拟好了一封通知，发出前需要你确认。';
        await this.#stream(sessionId, 'text', lead, signal);
        blocks.push({ type: 'text', text: lead });
        this.#emit(sessionId, { type: 'tool.call', callId, name: 'send_email' });
        this.#emit(sessionId, { type: 'tool.start', callId, name: 'send_email', input });
        this.#addPending(sessionId, { kind: 'confirm', callId, toolName: 'send_email', input, reason: '发送邮件给「项目组」', createdAt: isoAt(this.#now()) });
        this.#emit(sessionId, { type: 'confirm.request', callId, name: 'send_email', input, reason: '发送邮件给「项目组」' });
        this.#setStatus(sessionId, 'awaiting_confirm', 'send_email');
        const decision = await this.#waitFor(run, callId);
        const ok = decision === 'yes';
        this.#emit(sessionId, { type: 'tool.end', callId, name: 'send_email', isError: !ok, preview: ok ? '已发送' : '用户取消了发送', durationMs: 300 });
        blocks.push({ type: 'tool_use', id: callId, name: 'send_email', input }, { type: 'tool_result', toolUseId: callId, content: ok ? '已发送' : '用户取消了发送', isError: !ok });
        this.#setStatus(sessionId, 'thinking');
        const after = ok ? '\n\n邮件已经发出。' : '\n\n好的，这封邮件没有发。';
        await this.#stream(sessionId, 'text', after, signal);
        blocks.push({ type: 'text', text: after });
      } else if (/问|选/.test(text)) {
        const callId = this.#id('call');
        const question = '纪要按哪种口径写？';
        const options = ['只写结论', '结论加讨论过程', '按议题逐条写'];
        this.#addPending(sessionId, { kind: 'ask', callId, question, options, createdAt: isoAt(this.#now()) });
        this.#emit(sessionId, { type: 'ask.request', callId, question, options });
        this.#setStatus(sessionId, 'awaiting_answer');
        const answer = await this.#waitFor(run, callId);
        blocks.push({ type: 'tool_use', id: callId, name: 'ask_user', input: { question, options } }, { type: 'tool_result', toolUseId: callId, content: answer });
        this.#setStatus(sessionId, 'thinking');
        const after = `好，按「${answer}」来写。`;
        await this.#stream(sessionId, 'text', after, signal);
        blocks.push({ type: 'text', text: after });
      } else {
        const answer =
          '看完了，要点如下：\n\n' +
          '1. **外壳尺寸** 定为 120×80×24 mm，和上一版相比薄了 2 mm。\n' +
          '2. **续航** 要求不少于 10 小时，测试报告里实测 11.5 小时，达标。\n' +
          '3. **交付** 首批样机 20 台，月底前交付，时间比较紧。\n\n' +
          '报价单里还有两家供应商没回价，建议今天跟进一下。';
        await this.#stream(sessionId, 'text', answer, signal);
        blocks.push({ type: 'text', text: answer });
        const suggest = {
          title: '接下来可以',
          actions: [
            { label: '起草催价邮件', prompt: '帮我起草一封催价邮件，发给还没回价的两家供应商' },
            { label: '把要点整理成纪要', prompt: '把这些要点整理成评审纪要' },
          ],
        };
        const suggestId = this.#id('call');
        this.#emit(sessionId, { type: 'suggest.actions', callId: suggestId, ...suggest });
        blocks.push({ type: 'tool_use', id: suggestId, name: 'suggest_actions', input: suggest }, { type: 'tool_result', toolUseId: suggestId, content: '已给出建议' });
      }
      this.#commitAssistant(sessionId, blocks);
      this.#charge(sessionId, 3100, 260);
      this.#emit(sessionId, { type: 'turn.end', turn });
      this.#applySteers(sessionId, run);
      this.#finish(sessionId, 'completed');
    } catch (err) {
      if (err instanceof Aborted || signal.aborted) {
        // Keep what was already streamed, marked as interrupted.
        if (blocks.length) {
          const own = blocks.filter((b) => b.type !== 'tool_result');
          if (own.length) this.#append(sessionId, 'assistant', 'assistant', own, { interrupted: true });
        }
        this.#pending.set(sessionId, []);
        this.#finish(sessionId, 'aborted');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.#emit(sessionId, { type: 'error', message });
        this.#finish(sessionId, 'error', message);
      }
    }
  }

  #addPending(sessionId: string, item: PendingItem): void {
    this.#pending.set(sessionId, [...(this.#pending.get(sessionId) ?? []), item]);
  }

  #finish(sessionId: string, reason: 'completed' | 'aborted' | 'error', detail?: string): void {
    this.#runs.delete(sessionId);
    const s = this.#sessions.get(sessionId);
    const status: SessionStatus =
      reason === 'completed' ? (s?.role === 'worker' ? 'done' : 'idle') : reason === 'aborted' ? 'aborted' : 'error';
    this.#setStatus(sessionId, status);
    this.#emit(sessionId, detail ? { type: 'run.end', reason, detail } : { type: 'run.end', reason });
  }
}
