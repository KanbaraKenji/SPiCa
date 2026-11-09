// Hook registry for plugins. Every registration carries its source (plugin id)
// so that disabling a plugin withdraws everything it registered at once.
import type { ContextSegments, Injection } from './context.ts';
import type { ModelResponse } from './providers/types.ts';
import type { SessionInfo, ToolSpec } from './types.ts';

export interface HookContext {
  session: SessionInfo;
  runId: string;
  turn: number;
}

/** What a beforeRequest hook can see and change. */
export interface RequestDraft {
  segments: ContextSegments;
  tools: ToolSpec[];
  params: {
    providerId: string;
    model: string;
    maxTokens: number;
    temperature?: number;
    serverWebSearch?: boolean;
    extra?: Record<string, unknown>;
  };
}

export interface ToolCallDraft {
  callId: string;
  name: string;
  input: unknown;
  irreversible: boolean;
}

export type ToolDecision =
  | { action: 'allow'; input?: unknown }
  | { action: 'deny'; reason: string }
  | { action: 'confirm'; reason?: string; input?: unknown }
  /** Skip confirmation even for irreversible tools. */
  | { action: 'auto'; input?: unknown };

export interface ToolResultDraft {
  content: string;
  isError: boolean;
}

type MaybePromise<T> = T | Promise<T>;

export interface Hooks {
  /** Content to inject at the six relative positions. Re-evaluated every turn. */
  inject?(ctx: HookContext): MaybePromise<Omit<Injection, 'source'>[] | void>;
  /** Change segments, tool list or model parameters before the request is sent. */
  beforeRequest?(draft: RequestDraft, ctx: HookContext): MaybePromise<RequestDraft | void>;
  /** Change the complete response (text and tool calls) after it arrives. */
  afterResponse?(response: ModelResponse, ctx: HookContext): MaybePromise<ModelResponse | void>;
  /** Block, rewrite or require confirmation for a tool call. */
  beforeTool?(call: ToolCallDraft, ctx: HookContext): MaybePromise<ToolDecision | void>;
  /** Rewrite a tool result before the model sees it. */
  afterTool?(call: ToolCallDraft, result: ToolResultDraft, ctx: HookContext): MaybePromise<ToolResultDraft | void>;
}

interface Entry {
  id: number;
  source: string;
  priority: number;
  hooks: Hooks;
}

export class HookRegistry {
  #next = 1;
  #entries: Entry[] = [];

  /** Returns an unregister function. Lower priority runs first. */
  register(source: string, hooks: Hooks, opts: { priority?: number } = {}): () => void {
    const entry: Entry = { id: this.#next++, source, priority: opts.priority ?? 100, hooks };
    this.#entries.push(entry);
    this.#entries.sort((a, b) => a.priority - b.priority || a.id - b.id);
    return () => {
      this.#entries = this.#entries.filter((e) => e !== entry);
    };
  }

  unregisterSource(source: string): number {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((e) => e.source !== source);
    return before - this.#entries.length;
  }

  /** Sources registered by plugins (the core's own hooks, `core:*`, are not listed). */
  get sources(): string[] {
    return [...new Set(this.#entries.map((e) => e.source))].filter((s) => !s.startsWith('core:'));
  }

  async injections(ctx: HookContext): Promise<Injection[]> {
    const out: Injection[] = [];
    for (const e of this.#entries) {
      const list = await e.hooks.inject?.(ctx);
      for (const inj of list ?? []) out.push({ ...inj, source: e.source });
    }
    return out;
  }

  async beforeRequest(draft: RequestDraft, ctx: HookContext): Promise<RequestDraft> {
    let cur = draft;
    for (const e of this.#entries) cur = (await e.hooks.beforeRequest?.(cur, ctx)) ?? cur;
    return cur;
  }

  async afterResponse(res: ModelResponse, ctx: HookContext): Promise<ModelResponse> {
    let cur = res;
    for (const e of this.#entries) cur = (await e.hooks.afterResponse?.(cur, ctx)) ?? cur;
    return cur;
  }

  /**
   * Combine decisions: any deny wins; otherwise any confirm; `auto` from any
   * hook waives the default confirmation of irreversible tools.
   */
  async beforeTool(call: ToolCallDraft, ctx: HookContext): Promise<{ decision: ToolDecision; input: unknown }> {
    let input = call.input;
    let confirm: { reason?: string } | undefined;
    let auto = false;
    for (const e of this.#entries) {
      const d = await e.hooks.beforeTool?.({ ...call, input }, ctx);
      if (!d) continue;
      if (d.action === 'deny') return { decision: d, input };
      if ('input' in d && d.input !== undefined) input = d.input;
      if (d.action === 'confirm') confirm = { ...(d.reason ? { reason: d.reason } : {}) };
      if (d.action === 'auto') auto = true;
    }
    if (confirm) return { decision: { action: 'confirm', ...confirm }, input };
    if (call.irreversible && !auto) {
      return { decision: { action: 'confirm', reason: 'irreversible action' }, input };
    }
    return { decision: { action: 'allow' }, input };
  }

  async afterTool(call: ToolCallDraft, result: ToolResultDraft, ctx: HookContext): Promise<ToolResultDraft> {
    let cur = result;
    for (const e of this.#entries) cur = (await e.hooks.afterTool?.(call, cur, ctx)) ?? cur;
    return cur;
  }
}
