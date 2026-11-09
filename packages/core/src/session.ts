// One agent session: its own context, status, cost and the agent loop.
import { buildSegments, flattenSegments } from './context.ts';
import { isoNow } from './events.ts';
import type { CoreEventBody, RunEndReason } from './events.ts';
import type { HookContext, RequestDraft, ToolCallDraft } from './hooks.ts';
import type { ModelRequest, ModelResponse, CallInfo } from './providers/types.ts';
import { ProviderError } from './providers/types.ts';
import type { PendingRecord, SessionConfig, SessionRecord, ToolCallRecord } from './store/types.ts';
import { validateInput, type Tool, type ToolContext } from './tools/types.ts';
import type {
  ContentBlock,
  Message,
  MessageKind,
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

interface QueuedSteer {
  message: Message;
  mode: SteerMode;
}

const MAX_PARALLEL_TOOLS = 8;
const RESULT_PREVIEW = 200;
const MAX_RESULT_CHARS = 100_000;

export class Session {
  readonly id: string;
  readonly #rt: RuntimeInternals;
  #record: SessionRecord;
  #messages: Message[];
  #queue: QueuedSteer[] = [];
  #run: Promise<RunResult> | undefined;
  #runAbort: AbortController | undefined;
  #turnAbort: AbortController | undefined;
  #interrupt = false;
  #waiters: ((r: RunResult) => void)[] = [];
  #settleWaiters: (() => void)[] = [];
  /** Input size of the last model call (context only grows within a run), used for budget pre-checks. */
  #lastInputTokens = 0;

  constructor(rt: RuntimeInternals, record: SessionRecord, messages: Message[] = []) {
    this.#rt = rt;
    this.id = record.id;
    this.#record = record;
    this.#messages = messages;
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
  send(text: string, opts: { author?: 'user' | 'parent'; kind?: MessageKind } = {}): SendHandle {
    if (this.#run || this.#hasPending()) return this.steer(text, 'next', opts);
    const msg = this.#append({
      role: 'user',
      kind: opts.kind ?? 'user',
      content: [{ type: 'text', text }],
      meta: { author: opts.author ?? 'user' },
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
  steer(text: string, mode: SteerMode, opts: { author?: 'user' | 'parent' } = {}): SendHandle {
    if (!this.#run && !this.#hasPending()) return this.send(text, opts);
    const message: Message = {
      id: newId('msg'),
      sessionId: this.id,
      seq: -1,
      role: 'user',
      kind: 'steer',
      content: [{ type: 'text', text }],
      createdAt: isoNow(),
      meta: { author: opts.author ?? 'user', steerMode: mode },
    };
    this.#queue.push({ message, mode });
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
    this.#resolveCall(p, res.content, res.isError, res.isError ? 'error' : 'ok', true);
    return this.#maybeResume();
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
      this.#queue.push({ message, mode: 'next' });
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
              ? 'aborted'
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
      const env = { providerId: cfg.providerId, serverWebSearch: !!cfg.serverWebSearch };
      const tools = this.#rt.tools.list(env, cfg.tools);
      const injections = await this.#rt.hooks.injections(hctx);
      let draft: RequestDraft = {
        segments: buildSegments(cfg.system, this.#messages, injections),
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
      const provider = this.#rt.provider(draft.params.providerId);
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
      const check = this.#rt.ledger.precheck(scope, est, request.maxTokens);
      if (!check.ok) {
        this.#emit({ type: 'budget.stop', scope: check.scope, spentUsd: check.spentUsd, limitUsd: check.limitUsd, message: check.message });
        return end('budget', check.message);
      }

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
      try {
        for await (const ev of provider.stream(request, {
          signal,
          info: callInfo,
          onRetry: (r) => this.#emit({ type: 'error', message: `retrying model call (${r.reason})`, retryable: true }),
        })) {
          if (ev.type === 'text') {
            partialText += ev.delta;
            this.#emit({ type: 'text.delta', delta: ev.delta });
          } else if (ev.type === 'thinking') {
            this.#emit({ type: 'thinking.delta', delta: ev.delta });
          } else if (ev.type === 'tool_call') {
            this.#emit({ type: 'tool.call', callId: ev.id, name: ev.name });
          } else {
            response = ev.response;
          }
        }
      } catch (err) {
        lease.release();
        if (signal.aborted || isAbortError(err)) {
          trace.finish({ status: 'aborted', attempts: callInfo.attempts, ...(callInfo.httpStatus ? { httpStatus: callInfo.httpStatus } : {}) });
          if (partialText) {
            this.#append({ role: 'assistant', kind: 'assistant', content: [{ type: 'text', text: partialText }], meta: { interrupted: true } });
          }
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
        return end('error', message);
      }
      lease.release();
      if (!response) {
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
      const assistant = this.#append({
        role: 'assistant',
        kind: 'assistant',
        content: response.content,
        meta: { model: response.model, stopReason: response.stopReason, ...(response.rawStopReason ? { rawStopReason: response.rawStopReason } : {}) },
        ...(response.providerExtras ? { providerExtras: response.providerExtras } : {}),
      });
      if (JSON.stringify(response.content) !== streamed) {
        this.#emit({ type: 'message.replaced', messageId: assistant.id, content: response.content });
      }
      lastText = textOf(response.content) || lastText;

      const calls = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      if (calls.length === 0) {
        this.#emit({ type: 'turn.end', turn });
        if (this.#queue.length > 0) continue; // a steer arrived during the last turn
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
    const env = { providerId: cfg.providerId, serverWebSearch: !!cfg.serverWebSearch };
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
      const finish = (content: string, isError: boolean, status: ToolCallRecord['status']) => {
        this.#rt.store.upsertToolCall({ ...rec, status, result: content, endedAt: isoNow() });
      };
      if (!tool) {
        finish(`Unknown tool "${call.name}". Available tools: ${[...visible].join(', ')}.`, true, 'error');
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
      finish(res.content, res.isError, res.isError ? 'error' : 'ok');
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
  ): Promise<{ content: string; isError: boolean }> {
    this.#emit({ type: 'tool.start', callId: draft.callId, name: draft.name, input: draft.input });
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
    out = { content: `[fetched at ${fetchedAt}]\n${truncate(out.content, MAX_RESULT_CHARS)}`, isError: out.isError };
    this.#emit({
      type: 'tool.end',
      callId: draft.callId,
      name: draft.name,
      isError: out.isError,
      preview: out.content.slice(0, RESULT_PREVIEW),
      durationMs: Math.round(performance.now() - t0),
    });
    return out;
  }

  /** Append the tool_results message for an assistant message, from the tool-call records. */
  #appendToolResults(assistant: Message): void {
    const records = new Map(this.#rt.store.listToolCalls(this.id).map((r) => [r.id, r]));
    const content: ContentBlock[] = [];
    for (const b of assistant.content) {
      if (b.type !== 'tool_use') continue;
      const r = records.get(b.id);
      content.push({
        type: 'tool_result',
        toolUseId: b.id,
        content: r?.result ?? 'No result recorded.',
        ...(r && r.status !== 'ok' ? { isError: true } : {}),
      });
    }
    if (content.length > 0) this.#append({ role: 'user', kind: 'tool_results', content, meta: { author: 'runtime' } });
  }

  #resolveCall(p: PendingRecord, content: string, isError: boolean, status: ToolCallRecord['status'], stamped = false): void {
    const rec = this.#rt.store.listToolCalls(this.id).find((r) => r.id === p.callId);
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
    const records = new Map(this.#rt.store.listToolCalls(this.id).map((r) => [r.id, r]));
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
    if (this.#queue.length === 0) return;
    const items = this.#queue.splice(0);
    const ids: string[] = [];
    for (const { message } of items) {
      const m = this.#append(message);
      ids.push(m.id);
      if (m.kind === 'steer') this.#rt.onUserMessage(this, m);
    }
    this.#emit({ type: 'steer.applied', messageIds: ids });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  #append(m: Omit<Message, 'id' | 'sessionId' | 'seq' | 'createdAt'> & Partial<Pick<Message, 'id' | 'createdAt'>>): Message {
    const last = this.#messages[this.#messages.length - 1];
    const message: Message = {
      ...m,
      id: m.id ?? newId('msg'),
      sessionId: this.id,
      seq: (last?.seq ?? 0) + 1,
      createdAt: m.createdAt ?? isoNow(),
    };
    this.#messages.push(message);
    this.#rt.store.appendMessage(message);
    this.#emit({ type: 'message', message });
    return message;
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
