// One agent session: its own context, status, cost and the agent loop.
import { buildSegments, flattenSegments } from './context.ts';
import { isoNow } from './events.ts';
import type { CoreEventBody, RunEndReason } from './events.ts';
import type { HookContext, RequestDraft, ToolCallDraft } from './hooks.ts';
import type { ModelRequest, ModelResponse, CallInfo } from './providers/types.ts';
import { ProviderError } from './providers/types.ts';
import type { PendingRecord, SessionConfig, SessionRecord, ToolCallCards, ToolCallRecord } from './store/types.ts';
import { validateInput, type Tool, type ToolContext } from './tools/types.ts';
import type {
  ContentBlock,
  Message,
  MessageKind,
  MessageMeta,
  PendingItem,
  SessionInfo,
  SessionStatus,
  SteerMode,
  ToolUseBlock,
} from './types.ts';
import type { RuntimeInternals } from './runtime.ts';
import { estimateTokens, isAbortError, newId, truncate } from './util.ts';

export interface RunResult {
  reason: RunEndReason;
  detail?: string;
  /** Text of the last assistant message of the run. */
  text: string;
}

export interface SendHandle {
  messageId: string;
  /** True when this message started a run; false when it was queued into one. */
  started: boolean;
  /** Settles when the run that will consume this message ends. */
  done: Promise<RunResult>;
}

const MAX_PARALLEL_TOOLS = 8;
const PARTIAL_SAVE_MS = 1000;
const RESULT_PREVIEW = 200;
const MAX_RESULT_CHARS = 100_000;

export class Session {
  readonly id: string;
  readonly #rt: RuntimeInternals;
  #record: SessionRecord;
  #messages: Message[];
  #run: Promise<RunResult> | undefined;
  #runAbort: AbortController | undefined;
  #turnAbort: AbortController | undefined;
  #interrupt = false;
  #waiters: ((r: RunResult) => void)[] = [];
  #settleWaiters: (() => void)[] = [];
  /** Input size of the last model call (context only grows within a run), used for budget pre-checks. */
  #lastInputTokens = 0;

  #shutdown = false;

  constructor(rt: RuntimeInternals, record: SessionRecord, messages: Message[] = [], restored: { lastInputTokens?: number } = {}) {
    this.#rt = rt;
    this.id = record.id;
    this.#record = record;
    this.#messages = messages;
    this.#lastInputTokens = restored.lastInputTokens ?? 0;
  }

  /**
   * Stop for an application shutdown: the run ends as `interrupted` (not
   * `aborted`) so it can be resumed after restart. Resolves when stopped.
   */
  async shutdown(): Promise<void> {
    if (!this.#run) return;
    this.#shutdown = true;
    this.#runAbort?.abort(Object.assign(new Error('application shutting down'), { name: 'AbortError' }));
    await this.#run.catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Read access
  // ---------------------------------------------------------------------------

  get config(): SessionConfig {
    return this.#record.config;
  }

  get status(): SessionStatus {
    return this.#record.status;
  }

  get running(): boolean {
    return this.#run !== undefined;
  }

  get parentId(): string | null {
    return this.#record.parentId;
  }

  get parentChain(): string[] {
    return this.#rt.parentChain(this.id);
  }

  info(): SessionInfo {
    const r = this.#record;
    return {
      id: r.id,
      parentId: r.parentId,
      parentChain: this.parentChain,
      role: r.role,
      title: r.title,
      status: r.status,
      providerId: r.config.providerId,
      model: r.config.model,
      cwd: r.config.cwd,
      costUsd: this.#rt.ledger.sessionUsd(r.id),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ...(r.config.templateId ? { templateId: r.config.templateId } : {}),
      ...(r.config.projectId ? { projectId: r.config.projectId } : {}),
    };
  }

  messages(): Message[] {
    return structuredClone(this.#messages);
  }

  pending(): PendingItem[] {
    return this.#rt.store.listPending(this.id).map((p) => p.item);
  }

  /** Resolves when the current run (if any) ends. */
  idle(): Promise<RunResult | undefined> {
    return this.#run ?? Promise.resolve(undefined);
  }

  /** Resolves when nothing is running and nothing waits for the user. */
  settled(): Promise<void> {
    if (!this.#run && !this.#hasPending()) return Promise.resolve();
    return new Promise((r) => this.#settleWaiters.push(r));
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /** A message from the user (or the parent). Starts a run when idle; queued otherwise. */
  send(text: string, opts: { author?: 'user' | 'parent' | 'runtime'; kind?: MessageKind; meta?: Record<string, unknown> } = {}): SendHandle {
    if (this.#run || this.#hasPending()) return this.steer(text, 'next', opts);
    const msg = this.#append({
      role: 'user',
      kind: opts.kind ?? 'user',
      content: [{ type: 'text', text }],
      meta: { ...opts.meta, author: opts.author ?? 'user' },
    });
    this.#rt.onUserMessage(this, msg);
    const done = this.#startRun();
    return { messageId: msg.id, started: true, done };
  }

  /**
   * Insert a message into a running session. `next` applies it at the next
   * turn boundary; `interrupt` cuts the current model stream (or tool batch)
   * first, then applies it and continues.
   */
  steer(text: string, mode: SteerMode, opts: { author?: 'user' | 'parent' | 'runtime'; meta?: Record<string, unknown> } = {}): SendHandle {
    if (!this.#run && !this.#hasPending()) return this.send(text, opts);
    const message: Message = {
      id: newId('msg'),
      sessionId: this.id,
      seq: -1,
      role: 'user',
      kind: 'steer',
      content: [{ type: 'text', text }],
      createdAt: isoNow(),
      meta: { ...opts.meta, author: opts.author ?? 'user', steerMode: mode },
    };
    this.#rt.store.putQueued(message); // persisted: survives a crash before it is applied
    this.#emit({ type: 'steer.queued', messageId: message.id, mode });
    if (mode === 'interrupt' && this.#run) {
      this.#interrupt = true;
      this.#turnAbort?.abort(Object.assign(new Error('interrupted by user'), { name: 'AbortError' }));
    }
    const done = this.#run ?? new Promise<RunResult>((r) => this.#waiters.push(r));
    return { messageId: message.id, started: false, done };
  }

  /** Stop the run. Pending questions and confirmations are cancelled. */
  abort(reason = 'aborted by user'): void {
    if (this.#run) {
      this.#runAbort?.abort(Object.assign(new Error(reason), { name: 'AbortError' }));
      return;
    }
    if (this.#hasPending()) {
      for (const p of this.#rt.store.listPending(this.id)) {
        this.#resolveCall(p, `Cancelled: ${reason}.`, true, 'denied');
      }
      this.#flushResolvedResults();
      this.#setStatus('aborted');
      this.#finishWaiters({ reason: 'aborted', text: '' });
    }
  }

  /** Answer an ask_user card. */
  answer(callId: string, answer: string): Promise<RunResult> | undefined {
    const p = this.#findPending(callId, 'ask');
    this.#resolveCall(p, `User answered: ${answer}`, false, 'ok');
    this.#emit({ type: 'ask.resolved', callId, answer });
    return this.#maybeResume();
  }

  /** Approve or decline an action that needed confirmation. */
  async confirm(callId: string, approved: boolean): Promise<Promise<RunResult> | undefined> {
    const p = this.#findPending(callId, 'confirm');
    this.#emit({ type: 'confirm.resolved', callId, approved });
    if (!approved) {
      this.#resolveCall(p, 'The user declined this action. Do not retry it unless the user asks.', true, 'denied');
      return this.#maybeResume();
    }
    if (p.item.kind !== 'confirm') throw new Error('not a confirmation');
    // Mark as no longer pending before running so a crash does not re-ask.
    this.#rt.store.deletePending(this.id, callId);
    const tool = this.#rt.tools.get(p.item.toolName);
    const ac = new AbortController();
    this.#runAbort = ac;
    const draft: ToolCallDraft = { callId, name: p.item.toolName, input: p.item.input, irreversible: !!tool?.irreversible };
    const res = tool
      ? await this.#execute(tool, draft, ac.signal, this.#hookCtx('confirm', 0))
      : { content: `Unknown tool: ${p.item.toolName}`, isError: true };
    this.#runAbort = undefined;
    this.#resolveCall(p, res.content, res.isError, res.isError ? 'error' : 'ok', true, 'cards' in res ? res.cards : undefined);
    return this.#maybeResume();
  }

  /** Replace the tool allow-list (undefined = all tools). */
  setTools(tools: string[] | undefined): void {
    const { tools: _old, ...rest } = this.#record.config;
    void _old;
    this.#record = { ...this.#record, config: tools ? { ...rest, tools } : rest, updatedAt: isoNow() };
    this.#rt.store.upsertSession(this.#record);
  }

  /** Set or clear the display name. */
  rename(title: string | null): SessionInfo {
    this.#record = { ...this.#record, title: title && title.trim() !== '' ? title.trim() : null, updatedAt: isoNow() };
    this.#rt.store.upsertSession(this.#record);
    this.#emit({ type: 'session.renamed', title: this.#record.title });
    return this.info();
  }

  /** Continue a session left `interrupted` (e.g. after a restart). */
  resume(): Promise<RunResult> | undefined {
    if (this.#run || this.#hasPending()) return this.#run;
    this.#repairDanglingToolCalls('The previous run stopped before this tool call finished.');
    return this.#startRun();
  }

  /** Append a runtime note (relay, report, ...) without starting a run. */
  addNote(kind: MessageKind, text: string, meta: Record<string, unknown> = {}): Message {
    const message: Message = {
      id: newId('msg'),
      sessionId: this.id,
      seq: -1,
      role: 'user',
      kind,
      content: [{ type: 'text', text }],
      createdAt: isoNow(),
      meta,
    };
    if (this.#run || this.#hasPending()) {
      // Keep tool_use / tool_result pairs intact: apply at the next turn boundary.
      this.#rt.store.putQueued(message);
      return message;
    }
    return this.#append(message);
  }

  // ---------------------------------------------------------------------------
  // Agent loop
  // ---------------------------------------------------------------------------

  #startRun(): Promise<RunResult> {
    const p = this.#loop().finally(() => {
      this.#run = undefined;
      this.#runAbort = undefined;
      this.#turnAbort = undefined;
    });
    this.#run = p;
    void p.then((r) => {
      this.#rt.onRunEnd(this, r);
      this.#finishWaiters(r);
    });
    return p;
  }

  async #loop(): Promise<RunResult> {
    const runId = newId('run');
    const runAbort = new AbortController();
    this.#runAbort = runAbort;
    const cfg = this.#record.config;
    let turn = 0;
    let lastText = '';
    const end = (reason: RunEndReason, detail?: string): RunResult => {
      const status: SessionStatus =
        reason === 'completed' && this.#record.role === 'worker'
          ? 'done'
          : reason === 'completed' || reason === 'max_turns'
          ? 'idle'
          : reason === 'budget'
            ? 'idle'
            : reason === 'aborted'
              ? this.#shutdown
                ? 'interrupted'
                : 'aborted'
              : reason === 'error'
                ? 'error'
                : reason;
      this.#setStatus(status, detail);
      this.#emit({ type: 'run.end', reason, ...(detail ? { detail } : {}) });
      return { reason, ...(detail ? { detail } : {}), text: lastText };
    };

    for (;;) {
      if (runAbort.signal.aborted) return end('aborted', String(runAbort.signal.reason?.message ?? ''));
      this.#interrupt = false;
      this.#applyQueue();
      if (turn >= cfg.maxTurns) return end('max_turns', `stopped after ${cfg.maxTurns} turns`);
      turn++;
      this.#emit({ type: 'turn.start', turn });
      const turnAbort = new AbortController();
      this.#turnAbort = turnAbort;
      const signal = AbortSignal.any([runAbort.signal, turnAbort.signal]);
      const hctx = this.#hookCtx(runId, turn);

      // 1. Assemble context by segment and let plugins change the request.
      const env = {
      providerId: cfg.providerId,
      serverWebSearch: !!cfg.serverWebSearch,
      role: this.#record.role,
      ...(cfg.projectId ? { projectId: cfg.projectId } : {}),
      ...(cfg.templateId ? { templateId: cfg.templateId } : {}),
    };
      const tools = this.#rt.tools.list(env, cfg.tools);
      this.#noteToolsGone(new Set(tools.map((t) => t.spec.name)));
      const injections = await this.#rt.hooks.injections(hctx);
      let draft: RequestDraft = {
        segments: buildSegments(
          [cfg.system, languageLine(cfg.locale, this.#userHasWritten()), this.#leadsOthers() ? TEAM_RULE : ''].filter(Boolean).join('\n\n'),
          this.#messages,
          injections,
        ),
        tools: tools.map((t) => t.spec),
        params: {
          providerId: cfg.providerId,
          model: cfg.model,
          maxTokens: cfg.maxTokens,
          ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
          ...(cfg.serverWebSearch ? { serverWebSearch: true } : {}),
        },
      };
      draft = await this.#rt.hooks.beforeRequest(draft, hctx);
      let provider: ReturnType<RuntimeInternals['provider']>;
      try {
        provider = this.#rt.provider(draft.params.providerId);
      } catch (err) {
        // e.g. the provider was removed in the settings while this session still uses it
        const message = err instanceof Error ? err.message : String(err);
        this.#emit({ type: 'error', message });
        return end('error', message);
      }
      const flat = flattenSegments(draft.segments, this.id);
      const request: ModelRequest = {
        model: draft.params.model,
        system: flat.system,
        messages: flat.messages,
        tools: draft.tools,
        maxTokens: draft.params.maxTokens,
        ...(draft.params.temperature !== undefined ? { temperature: draft.params.temperature } : {}),
        ...(draft.params.serverWebSearch && provider.capabilities.serverWebSearch
          ? { serverTools: [{ kind: 'web_search' as const }] }
          : {}),
        ...(draft.params.extra ? { extra: draft.params.extra } : {}),
      };

      // 2. Spending limits (worst case for this call).
      const scope = { providerId: provider.id, providerKind: provider.kind, model: request.model, sessionId: this.id, runId };
      const est = Math.max(
        estimateTokens(request.system + JSON.stringify(request.messages) + JSON.stringify(request.tools)),
        this.#lastInputTokens,
      );
      // 3. Rate limiter shared by all sessions on this endpoint.
      let lease;
      try {
        lease = await this.#rt.limiter(provider.id).acquire({
          signal,
          onPosition: (position) => {
            this.#setStatus('queued', `position ${position}`);
            this.#emit({ type: 'queue', position, waitingFor: provider.id });
          },
        });
      } catch (err) {
        if (isAbortError(err) && this.#interrupt && !runAbort.signal.aborted) {
          this.#emit({ type: 'turn.end', turn });
          turn--; // nothing was sent
          continue;
        }
        return end('aborted');
      }

      // Checked once a slot is free, against what is spent plus the worst case
      // of every call still running, so parallel sessions cannot overshoot together.
      let hold = this.#rt.ledger.reserve(scope, est, request.maxTokens);
      // Over the limit only because of calls still running: wait until they are
      // recorded at their real cost, then check again (keeping the slot).
      while (!hold.ok && hold.wait) {
        this.#setStatus('queued', 'waiting for running calls to settle the spending limit');
        try {
          await this.#rt.ledger.released(signal);
        } catch {
          lease.release();
          if (this.#interrupt && !runAbort.signal.aborted) {
            this.#emit({ type: 'turn.end', turn });
            turn--;
            break;
          }
          return end('aborted');
        }
        hold = this.#rt.ledger.reserve(scope, est, request.maxTokens);
      }
      if (!hold.ok && hold.wait) continue; // interrupted while waiting: next turn with the steer
      if (!hold.ok) {
        lease.release();
        this.#emit({ type: 'budget.stop', scope: hold.scope, spentUsd: hold.spentUsd, limitUsd: hold.limitUsd, message: hold.message });
        return end('budget', hold.message);
      }

      // 4. Stream the model call.
      this.#setStatus('thinking');
      const trace = this.#rt.tracer.start({
        kind: 'model',
        sessionId: this.id,
        parentChain: this.parentChain,
        initiator: 'model',
        target: provider.traceTarget,
        providerId: provider.id,
        model: request.model,
      });
      const callInfo: CallInfo = { attempts: 0 };
      let response: ModelResponse | undefined;
      let partialText = '';
      // The answer so far is saved about once a second (meta.partial), so a
      // hard kill keeps what the user already saw.
      const partial = { id: newId('msg'), seq: this.#nextSeq(), saved: false, savedLen: 0, at: -Infinity, createdAt: isoNow() };
      let partialTimer: ReturnType<typeof setTimeout> | undefined;
      const stopPartialTimer = () => {
        clearTimeout(partialTimer);
        partialTimer = undefined;
      };
      const savePartial = (force = false) => {
        if (partialText.length === partial.savedLen) return;
        const wait = PARTIAL_SAVE_MS - (performance.now() - partial.at);
        if (!force && wait > 0) {
          // throttled: make sure the latest text is saved even if the stream stalls
          partialTimer ??= setTimeout(() => {
            partialTimer = undefined;
            savePartial(true);
          }, wait);
          return;
        }
        const msg: Message = {
          id: partial.id,
          sessionId: this.id,
          seq: partial.seq,
          role: 'assistant',
          kind: 'assistant',
          content: [{ type: 'text', text: partialText }],
          createdAt: partial.createdAt,
          meta: { partial: true },
        };
        if (partial.saved) this.#rt.store.updateMessage(msg);
        else this.#rt.store.appendMessage(msg);
        partial.saved = true;
        partial.savedLen = partialText.length;
        partial.at = performance.now();
      };
      const keepPartial = (meta: Record<string, unknown>) => {
        stopPartialTimer();
        if (!partialText) return;
        this.#append(
          { id: partial.id, createdAt: partial.createdAt, role: 'assistant', kind: 'assistant', content: [{ type: 'text', text: partialText }], meta },
          { seq: partial.seq, persisted: partial.saved },
        );
      };
      try {
        for await (const ev of provider.stream(request, {
          signal,
          info: callInfo,
          onRetry: (r) => this.#emit({ type: 'error', message: `retrying model call (${r.reason})`, retryable: true }),
        })) {
          if (ev.type === 'text') {
            partialText += ev.delta;
            this.#emit({ type: 'text.delta', delta: ev.delta });
            savePartial();
          } else if (ev.type === 'thinking') {
            this.#emit({ type: 'thinking.delta', delta: ev.delta });
          } else if (ev.type === 'tool_call') {
            this.#emit({ type: 'tool.call', callId: ev.id, name: ev.name });
          } else {
            response = ev.response;
          }
        }
      } catch (err) {
        stopPartialTimer();
        lease.release();
        hold.release(); // nothing was reported back for this call
        if (signal.aborted || isAbortError(err)) {
          trace.finish({ status: 'aborted', attempts: callInfo.attempts, ...(callInfo.httpStatus ? { httpStatus: callInfo.httpStatus } : {}) });
          keepPartial({ interrupted: true });
          this.#emit({ type: 'turn.end', turn });
          if (this.#interrupt && !runAbort.signal.aborted) continue;
          return end('aborted', String(runAbort.signal.reason?.message ?? 'aborted'));
        }
        const message = err instanceof Error ? err.message : String(err);
        trace.finish({
          status: 'error',
          error: message,
          attempts: callInfo.attempts,
          ...(err instanceof ProviderError && err.status ? { httpStatus: err.status } : {}),
        });
        this.#emit({ type: 'error', message, retryable: err instanceof ProviderError && err.retryable });
        keepPartial({ interrupted: true, error: true });
        return end('error', message);
      }
      stopPartialTimer();
      lease.release();
      if (!response) {
        hold.release();
        trace.finish({ status: 'error', error: 'stream ended without a response', attempts: callInfo.attempts });
        return end('error', 'model stream ended without a response');
      }

      // 5. Cost and traceable record.
      const u = response.usage;
      this.#lastInputTokens = u.inputTokens + (provider.kind === 'anthropic' ? (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) : 0);
      const cost = this.#rt.ledger.record(scope, response.usage);
      trace.finish({
        status: 'ok',
        model: response.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        ...(response.usage.cacheReadTokens !== undefined ? { cacheReadTokens: response.usage.cacheReadTokens } : {}),
        ...(response.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: response.usage.cacheWriteTokens } : {}),
        costUsd: cost.costUsd,
        attempts: callInfo.attempts,
        ...(callInfo.httpStatus ? { httpStatus: callInfo.httpStatus } : {}),
      });
      this.#emit({ type: 'usage', usage: response.usage, costUsd: cost.costUsd, providerId: provider.id, model: response.model });
      for (const t of cost.totals) {
        if (t.scope === 'call') continue;
        this.#emit({ type: 'cost', scope: t.scope, spentUsd: t.spentUsd, ...(t.limitUsd !== undefined ? { limitUsd: t.limitUsd } : {}), warning: t.warning });
      }

      // 6. Plugins may rewrite the complete response.
      const streamed = JSON.stringify(response.content);
      response = await this.#rt.hooks.afterResponse(response, hctx);
      const assistant = this.#append(
        {
          id: partial.id,
          createdAt: partial.createdAt,
          role: 'assistant',
          kind: 'assistant',
          content: response.content,
          meta: { model: response.model, stopReason: response.stopReason, ...(response.rawStopReason ? { rawStopReason: response.rawStopReason } : {}) },
          ...(response.providerExtras ? { providerExtras: response.providerExtras } : {}),
        },
        { seq: partial.seq, persisted: partial.saved },
      );
      if (JSON.stringify(response.content) !== streamed) {
        this.#emit({ type: 'message.replaced', messageId: assistant.id, content: response.content });
      }
      lastText = textOf(response.content) || lastText;

      const calls = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      if (calls.length === 0) {
        this.#emit({ type: 'turn.end', turn });
        if (this.#rt.store.listQueued(this.id).length > 0) continue; // a steer arrived during the last turn
        return end('completed');
      }

      // 7. Tools.
      this.#setStatus('tool');
      const paused = await this.#runTools(assistant, calls, signal, hctx);
      this.#emit({ type: 'turn.end', turn });
      if (paused) {
        const kinds = this.#rt.store.listPending(this.id).map((p) => p.item.kind);
        return end(kinds.includes('confirm') ? 'awaiting_confirm' : 'awaiting_answer');
      }
      if (runAbort.signal.aborted) return end('aborted', String(runAbort.signal.reason?.message ?? 'aborted'));
    }
  }

  /** Run a turn's tool calls. Returns true when the run must pause for the user. */
  async #runTools(assistant: Message, calls: ToolUseBlock[], signal: AbortSignal, hctx: HookContext): Promise<boolean> {
    const cfg = this.#record.config;
    const env = {
      providerId: cfg.providerId,
      serverWebSearch: !!cfg.serverWebSearch,
      role: this.#record.role,
      ...(cfg.projectId ? { projectId: cfg.projectId } : {}),
      ...(cfg.templateId ? { templateId: cfg.templateId } : {}),
    };
    const visible = new Set(this.#rt.tools.list(env, cfg.tools).map((t) => t.spec.name));
    const pending: PendingRecord[] = [];

    const work = calls.map((call) => async () => {
      const tool = visible.has(call.name) ? this.#rt.tools.get(call.name) : undefined;
      const rec: ToolCallRecord = {
        id: call.id,
        sessionId: this.id,
        messageId: assistant.id,
        name: call.name,
        input: call.input,
        status: 'running',
        startedAt: isoNow(),
      };
      const finish = (content: string, isError: boolean, status: ToolCallRecord['status'], cards?: ToolCallCards) => {
        this.#rt.store.upsertToolCall({ ...rec, status, result: content, endedAt: isoNow(), ...(cards ? { cards } : {}) });
      };
      if (!tool) {
        const gone = this.#rt.tools.removedFrom(call.name) !== undefined || this.#calledBefore(call.name, assistant.id);
        finish(
          gone
            ? `Tool "${call.name}" is no longer available (it was turned off or removed). Nothing was run. Do not call it again; if the task needs it, tell the user.`
            : `Unknown tool "${call.name}". Available tools: ${[...visible].join(', ')}.`,
          true,
          'unavailable',
        );
        return;
      }
      const invalid = validateInput(tool.spec.inputSchema, call.input);
      if (invalid) {
        finish(`Invalid input for ${call.name}: ${invalid}.`, true, 'error');
        return;
      }
      const draft: ToolCallDraft = { callId: call.id, name: call.name, input: call.input, irreversible: !!tool.irreversible };
      const { decision, input } = await this.#rt.hooks.beforeTool(draft, hctx);
      if (decision.action === 'deny') {
        finish(`Blocked: ${decision.reason}`, true, 'denied');
        return;
      }
      if (tool.interaction === 'ask') {
        const obj = (input ?? {}) as Record<string, unknown>;
        const options = Array.isArray(obj.options) ? obj.options.map(String) : undefined;
        const item: PendingItem = {
          kind: 'ask',
          callId: call.id,
          question: String(obj.question ?? ''),
          ...(options ? { options } : {}),
          createdAt: isoNow(),
        };
        this.#rt.store.upsertToolCall({ ...rec, input, status: 'pending' });
        pending.push({ sessionId: this.id, callId: call.id, messageId: assistant.id, item });
        return;
      }
      if (decision.action === 'confirm') {
        const item: PendingItem = {
          kind: 'confirm',
          callId: call.id,
          toolName: call.name,
          input,
          reason: decision.reason ?? 'needs confirmation',
          createdAt: isoNow(),
        };
        this.#rt.store.upsertToolCall({ ...rec, input, status: 'pending' });
        pending.push({ sessionId: this.id, callId: call.id, messageId: assistant.id, item });
        return;
      }
      this.#rt.store.upsertToolCall({ ...rec, input });
      const res = await this.#execute(tool, { ...draft, input }, signal, hctx);
      finish(res.content, res.isError, res.isError ? 'error' : 'ok', res.cards);
    });
    await runLimited(work, MAX_PARALLEL_TOOLS);

    if (pending.length > 0) {
      for (const p of pending) {
        this.#rt.store.putPending(p);
        if (p.item.kind === 'ask') {
          this.#emit({ type: 'ask.request', callId: p.callId, question: p.item.question, ...(p.item.options ? { options: p.item.options } : {}) });
        } else {
          this.#emit({ type: 'confirm.request', callId: p.callId, name: p.item.toolName, input: p.item.input, reason: p.item.reason });
        }
      }
      return true;
    }
    this.#appendToolResults(assistant);
    return false;
  }

  /** Execute one tool with hooks, timing, events and the fetch-time stamp. */
  async #execute(
    tool: Tool,
    draft: ToolCallDraft,
    signal: AbortSignal,
    hctx: HookContext,
  ): Promise<{ content: string; isError: boolean; cards?: ToolCallCards }> {
    this.#emit({ type: 'tool.start', callId: draft.callId, name: draft.name, input: draft.input });
    // Card events are also kept with the call, so history can rebuild them.
    let cards: ToolCallCards | undefined;
    const t0 = performance.now();
    const fetchedAt = isoNow();
    let out: { content: string; isError: boolean };
    const ctx: ToolContext = {
      sessionId: this.id,
      parentChain: this.parentChain,
      cwd: this.#record.config.cwd,
      signal,
      tracer: this.#rt.tracer,
      extractors: this.#rt.extractors,
      services: this.#rt.services(this),
      callId: draft.callId,
      emit: (body) => {
        if (body.type === 'file.card') cards = { ...cards, fileCard: body.file };
        if (body.type === 'suggest.actions') cards = { ...cards, suggestion: { title: body.title, actions: body.actions } };
        this.#emit(body);
      },
    };
    try {
      const r = await tool.execute((draft.input ?? {}) as Record<string, unknown>, ctx);
      out = { content: r.content, isError: !!r.isError };
    } catch (err) {
      out = signal.aborted
        ? { content: 'Aborted: the user interrupted this tool call.', isError: true }
        : { content: `Tool failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    out = await this.#rt.hooks.afterTool(draft, out, hctx);
    this.#rt.onToolDone(this, draft, out);
    out = { content: `[fetched at ${fetchedAt}]\n${truncate(out.content, MAX_RESULT_CHARS)}`, isError: out.isError };
    this.#emit({
      type: 'tool.end',
      callId: draft.callId,
      name: draft.name,
      isError: out.isError,
      preview: out.content.slice(0, RESULT_PREVIEW),
      durationMs: Math.round(performance.now() - t0),
    });
    return cards ? { ...out, cards } : out;
  }

  /** Append the tool_results message for an assistant message, from the tool-call records. */
  #appendToolResults(assistant: Message): void {
    const records = new Map(this.#rt.store.listToolCalls(this.id, assistant.id).map((r) => [r.id, r]));
    const content: ContentBlock[] = [];
    const fileCards: NonNullable<MessageMeta['fileCards']> = {};
    const suggestedActions: NonNullable<MessageMeta['suggestedActions']> = {};
    for (const b of assistant.content) {
      if (b.type !== 'tool_use') continue;
      const r = records.get(b.id);
      if (r?.cards?.fileCard) fileCards[b.id] = r.cards.fileCard;
      if (r?.cards?.suggestion) suggestedActions[b.id] = r.cards.suggestion;
      content.push({
        type: 'tool_result',
        toolUseId: b.id,
        content: r?.result ?? 'No result recorded.',
        ...(r && r.status !== 'ok' ? { isError: true } : {}),
      });
    }
    if (content.length === 0) return;
    const meta: MessageMeta = {
      author: 'runtime',
      ...(Object.keys(fileCards).length > 0 ? { fileCards } : {}),
      ...(Object.keys(suggestedActions).length > 0 ? { suggestedActions } : {}),
    };
    this.#append({ role: 'user', kind: 'tool_results', content, meta });
  }

  #resolveCall(
    p: PendingRecord,
    content: string,
    isError: boolean,
    status: ToolCallRecord['status'],
    stamped = false,
    cards?: ToolCallCards,
  ): void {
    const rec = this.#rt.store.listToolCalls(this.id, p.messageId).find((r) => r.id === p.callId);
    const result = stamped ? content : `[fetched at ${isoNow()}]\n${content}`;
    this.#rt.store.upsertToolCall({
      ...(rec ?? {
        id: p.callId,
        sessionId: this.id,
        messageId: p.messageId,
        name: p.item.kind === 'confirm' ? p.item.toolName : 'ask_user',
        input: p.item.kind === 'confirm' ? p.item.input : { question: p.item.question },
        startedAt: p.item.createdAt,
      }),
      status,
      result,
      endedAt: isoNow(),
      ...(cards ? { cards } : {}),
    });
    this.#rt.store.deletePending(this.id, p.callId);
  }

  #maybeResume(): Promise<RunResult> | undefined {
    if (this.#hasPending()) return undefined;
    this.#flushResolvedResults();
    return this.#startRun();
  }

  /** After all pending calls are resolved, write the tool_results message. */
  #flushResolvedResults(): void {
    const last = [...this.#messages].reverse().find((m) => m.role === 'assistant');
    if (!last || !last.content.some((b) => b.type === 'tool_use')) return;
    const idx = this.#messages.indexOf(last);
    if (this.#messages.slice(idx + 1).some((m) => m.kind === 'tool_results')) return;
    this.#appendToolResults(last);
  }

  /** Give every tool_use without a result an error result (after a crash). */
  #repairDanglingToolCalls(reason: string): void {
    const last = [...this.#messages].reverse().find((m) => m.role === 'assistant');
    if (!last) return;
    const idx = this.#messages.indexOf(last);
    if (this.#messages.slice(idx + 1).some((m) => m.kind === 'tool_results')) return;
    const calls = last.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (calls.length === 0) return;
    const records = new Map(this.#rt.store.listToolCalls(this.id, last.id).map((r) => [r.id, r]));
    for (const c of calls) {
      const r = records.get(c.id);
      if (!r || r.status === 'running') {
        this.#rt.store.upsertToolCall({
          id: c.id,
          sessionId: this.id,
          messageId: last.id,
          name: c.name,
          input: c.input,
          status: 'error',
          result: `[fetched at ${isoNow()}]\n${reason}`,
          startedAt: r?.startedAt ?? isoNow(),
          endedAt: isoNow(),
        });
      }
    }
    this.#appendToolResults(last);
  }

  #applyQueue(): void {
    const items = this.#rt.store.listQueued(this.id);
    if (items.length === 0) return;
    const ids: string[] = [];
    for (const message of items) {
      const m = this.#append(message);
      this.#rt.store.deleteQueued(this.id, message.id);
      if (m.kind !== 'steer') continue; // relay / report notes are not user steers
      ids.push(m.id);
      this.#rt.onUserMessage(this, m);
    }
    if (ids.length > 0) this.#emit({ type: 'steer.applied', messageIds: ids });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  #append(
    m: Omit<Message, 'id' | 'sessionId' | 'seq' | 'createdAt'> & Partial<Pick<Message, 'id' | 'createdAt'>>,
    opts: { seq?: number; persisted?: boolean } = {},
  ): Message {
    const message: Message = {
      ...m,
      id: m.id ?? newId('msg'),
      sessionId: this.id,
      seq: opts.seq ?? this.#nextSeq(),
      createdAt: m.createdAt ?? isoNow(),
    };
    this.#messages.push(message);
    if (opts.persisted) this.#rt.store.updateMessage(message);
    else this.#rt.store.appendMessage(message);
    this.#emit({ type: 'message', message });
    return message;
  }

  /** Whether an earlier assistant message (not `exceptId`) called this tool. */
  #calledBefore(name: string, exceptId: string): boolean {
    return this.#messages.some((m) => m.id !== exceptId && m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use' && b.name === name));
  }

  /**
   * Tools this session used earlier that are gone now (a plugin was turned
   * off): tell the model once, as a runtime note, so it does not keep calling
   * them from what it sees in the history.
   */
  #noteToolsGone(visible: Set<string>): void {
    const lastUse = new Map<string, number>();
    const lastNote = new Map<string, number>();
    // calls that were refused as unavailable do not count: the model was already told in their result
    const refused = new Set(this.#rt.store.listToolCalls(this.id).filter((c) => c.status === 'unavailable').map((c) => `${c.messageId}|${c.id}`));
    for (const m of this.#messages) {
      if (m.role === 'assistant') for (const b of m.content) if (b.type === 'tool_use' && !refused.has(`${m.id}|${b.id}`)) lastUse.set(b.name, m.seq);
      const said = m.meta?.toolsUnavailable;
      if (Array.isArray(said)) for (const n of said) lastNote.set(String(n), m.seq);
    }
    // only tools this runtime saw being taken away (not, say, one whose plugin has not started yet after a restart)
    const gone = [...lastUse]
      .filter(([name, seq]) => !visible.has(name) && this.#rt.tools.removedFrom(name) !== undefined && (lastNote.get(name) ?? -1) < seq)
      .map(([name]) => name);
    if (gone.length === 0) return;
    this.#append({
      role: 'user',
      kind: 'note',
      content: [
        {
          type: 'text',
          text: `[System note] These tools are no longer available (turned off or removed): ${gone.join(', ')}. Do not call them. If the task needs them, tell the user.`,
        },
      ],
      meta: { author: 'runtime', toolsUnavailable: gone },
    });
  }

  /** The user has typed at least one message in this session (not the system or another agent). */
  #userHasWritten(): boolean {
    return this.#messages.some((m) => m.role === 'user' && (m.kind === 'user' || m.kind === 'steer') && (m.meta?.author ?? 'user') === 'user');
  }

  /** Top-level agent, project manager, or any session that has sub-agents. */
  #leadsOthers(): boolean {
    return this.#record.role === 'top' || this.#record.role === 'manager' || this.#rt.hasChildren(this.id);
  }

  #nextSeq(): number {
    return (this.#messages[this.#messages.length - 1]?.seq ?? 0) + 1;
  }

  #setStatus(status: SessionStatus, detail?: string): void {
    if (this.#record.status === status && !detail) return;
    this.#record = { ...this.#record, status, updatedAt: isoNow() };
    this.#rt.store.upsertSession(this.#record);
    this.#emit({ type: 'status', status, ...(detail ? { detail } : {}) });
    this.#rt.onStatus(this, status);
  }

  #emit(body: CoreEventBody): void {
    this.#rt.events.emit({ sessionId: this.id, parentChain: this.parentChain }, body);
  }

  #hookCtx(runId: string, turn: number): HookContext {
    return { session: this.info(), runId, turn };
  }

  #hasPending(): boolean {
    return this.#rt.store.listPending(this.id).length > 0;
  }

  #findPending(callId: string, kind: PendingItem['kind']): PendingRecord {
    const p = this.#rt.store.listPending(this.id).find((x) => x.callId === callId);
    if (!p || p.item.kind !== kind) throw new Error(`no pending ${kind} with id ${callId}`);
    return p;
  }

  #finishWaiters(r: RunResult): void {
    const w = this.#waiters.splice(0);
    for (const fn of w) fn(r);
    if (!this.#run && !this.#hasPending()) for (const fn of this.#settleWaiters.splice(0)) fn();
  }
}

/**
 * For sessions that lead sub-agents: what the user says or decides inside a
 * sub-agent session overrides the original plan (project brief J4).
 */
export const TEAM_RULE =
  'The user can talk to your sub-agents directly. When a note tells you what the user said or decided in a sub-agent ' +
  'session, that takes priority over your original plan: apply it to your overall result, and say in your answer that ' +
  'you adjusted it because of what the user said in that sub-agent session.';

/** Answer in the user's language; before the user has written, use the interface language. */
export function languageLine(locale: string | undefined, userHasWritten = true): string {
  const lang = locale ?? 'zh-CN';
  if (!userHasWritten) {
    // e.g. a project manager that so far only got forwarded mail or tasks from other agents
    return (
      `Write everything for the user in the interface language: ${lang}, including short remarks before tool calls. ` +
      'Messages and notes from the system or other agents (often in English) do not change that.'
    );
  }
  return (
    'Reply in the language of the latest message the user typed themselves, including short remarks before tool calls. ' +
    `Messages and notes from the system or other agents (often in English) do not count. When unclear, use the interface language: ${lang}.`
  );
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');
}

async function runLimited(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) {
      const t = tasks[i++]!;
      await t();
    }
  });
  await Promise.all(workers);
}
