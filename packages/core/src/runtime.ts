// Runtime: owns the session tree and everything sessions share
// (providers, rate limiters, cost ledger, hooks, tools, store, event bus).
import { CostLedger, DEFAULT_PRICES, type BudgetConfig, type PriceTable } from './cost.ts';
import { EventBus, isoNow } from './events.ts';
import { HookRegistry } from './hooks.ts';
import { RateLimiter, type LimiterConfig } from './limiter.ts';
import type { Provider } from './providers/types.ts';
import { Session, type RunResult } from './session.ts';
import { MemoryStore } from './store/memory.ts';
import type { RelayRecord, SessionConfig, SessionRecord, Store } from './store/types.ts';
import { agentTools } from './tools/agent-tools.ts';
import { createRunCommandTool } from './tools/command-tool.ts';
import { createWebFetchTool, createWebSearchTool, type SearchBackend } from './tools/web-tools.ts';
import { connectMcp, type McpServerConfig, type McpStdioClient } from './mcp/client.ts';
import { fileTools } from './tools/fs-tools.ts';
import { ToolRegistry, type FileExtractor, type Tool } from './tools/types.ts';
import { Tracer } from './trace.ts';
import type { AgentRole, ChildNoteMeta, CreateSessionRequest, Message, SessionStatus } from './types.ts';
import { newId } from './util.ts';

export interface RuntimeOptions {
  providers: Provider[];
  /** Defaults for new sessions. */
  defaults: { providerId: string; model: string; maxTokens: number; maxTurns?: number; system?: string };
  store?: Store;
  /** Rate limits per provider id (deployment configuration). */
  limits?: Record<string, LimiterConfig>;
  prices?: PriceTable;
  budget?: BudgetConfig;
  /** Built-in tools to register. Default: file tools, run_command, ask_user, suggest_actions and the session-tree tools. */
  tools?: Tool[];
  extractors?: FileExtractor[];
  /** Default working folder for sessions. */
  cwd?: string;
  /** Where run_command saves outputs too long to return (default: a temp folder). */
  spillDir?: string;
  /** Search backend for web_search. Without one (and without hosted search) the tool is not offered. */
  search?: SearchBackend;
  /** Use the model's own hosted web search when the provider has it. Default true. */
  hostedWebSearch?: boolean;
  /** Interface language for new sessions (BCP 47). Default zh-CN. */
  locale?: string;
}

/** What sessions need from the runtime. Not part of the public API. */
export interface RuntimeInternals {
  readonly events: EventBus;
  readonly hooks: HookRegistry;
  readonly tools: ToolRegistry;
  readonly store: Store;
  readonly tracer: Tracer;
  readonly ledger: CostLedger;
  readonly extractors: FileExtractor[];
  provider(id: string): Provider;
  limiter(providerId: string): RateLimiter;
  parentChain(sessionId: string): string[];
  services(session: Session): Record<string, unknown>;
  onUserMessage(session: Session, message: Message): void;
  onStatus(session: Session, status: SessionStatus): void;
  onRunEnd(session: Session, result: RunResult): void;
}

/** How a session is named in text written for the model. */
function label(s: Session): string {
  const title = s.info().title;
  return title ? `"${title}" (${s.id})` : s.id;
}

export const DEFAULT_SYSTEM_PROMPT =
  'You are an agent in Spica, a desktop workbench. Use the available tools to inspect files and gather facts ' +
  'instead of guessing. Every tool result starts with the time the data was fetched; treat older results as ' +
  'possibly out of date and fetch again when the current state matters. Be concise.';

export class Runtime implements RuntimeInternals {
  readonly events = new EventBus();
  readonly hooks = new HookRegistry();
  readonly tools = new ToolRegistry();
  readonly store: Store;
  readonly tracer: Tracer;
  readonly ledger: CostLedger;
  readonly extractors: FileExtractor[];
  readonly #providers = new Map<string, Provider>();
  readonly #limiters = new Map<string, RateLimiter>();
  readonly #sessions = new Map<string, Session>();
  readonly #opts: RuntimeOptions;
  readonly #mcp = new Map<string, { client: McpStdioClient; source: string; disconnect: () => Promise<void> }>();
  readonly #reports = new Map<string, string>();

  constructor(opts: RuntimeOptions) {
    this.#opts = opts;
    this.store = opts.store ?? new MemoryStore();
    this.tracer = new Tracer(this.store, this.events);
    this.ledger = new CostLedger(opts.prices ?? DEFAULT_PRICES, opts.budget ?? {});
    this.extractors = [...(opts.extractors ?? [])];
    for (const p of opts.providers) this.addProvider(p, opts.limits?.[p.id]);
    const defaults = [
      ...fileTools,
      createRunCommandTool(opts.spillDir ? { spillDir: opts.spillDir } : {}),
      createWebFetchTool(),
      ...(opts.search ? [createWebSearchTool(opts.search)] : []),
      ...agentTools,
    ];
    for (const t of opts.tools ?? defaults) this.tools.register(t, 'core');
  }

  addProvider(p: Provider, limits?: LimiterConfig): void {
    this.#providers.set(p.id, p);
    p.attach?.({ tracer: this.tracer });
    this.#limiters.set(p.id, new RateLimiter(limits ?? {}));
  }

  provider(id: string): Provider {
    const p = this.#providers.get(id);
    if (!p) throw new Error(`unknown provider: ${id}`);
    return p;
  }

  limiter(providerId: string): RateLimiter {
    let l = this.#limiters.get(providerId);
    if (!l) {
      l = new RateLimiter({});
      this.#limiters.set(providerId, l);
    }
    return l;
  }

  createSession(req: CreateSessionRequest = {}): Session {
    const d = this.#opts.defaults;
    const parent = req.parentId ? this.session(req.parentId) : undefined;
    if (req.parentId && !parent) throw new Error(`unknown parent session: ${req.parentId}`);
    const now = isoNow();
    const role: AgentRole = req.role ?? (parent ? 'worker' : 'top');
    const config: SessionConfig = {
      system: req.system ?? d.system ?? DEFAULT_SYSTEM_PROMPT,
      providerId: req.providerId ?? parent?.config.providerId ?? d.providerId,
      model: req.model ?? (req.providerId ? undefined : parent?.config.model) ?? d.model,
      maxTokens: req.maxTokens ?? d.maxTokens,
      cwd: req.cwd ?? parent?.config.cwd ?? this.#opts.cwd ?? process.cwd(),
      maxTurns: req.maxTurns ?? d.maxTurns ?? 50,
      locale: req.locale ?? parent?.config.locale ?? this.#opts.locale ?? 'zh-CN',
      serverWebSearch: false,
      // A sub-agent gets its parent's tool allow-list unless told otherwise.
      ...((req.tools ?? parent?.config.tools) ? { tools: req.tools ?? parent?.config.tools } : {}),
    };
    const provider = this.provider(config.providerId); // fail fast
    config.serverWebSearch = (this.#opts.hostedWebSearch ?? true) && provider.capabilities.serverWebSearch;
    const record: SessionRecord = {
      id: newId('ses'),
      parentId: parent?.id ?? null,
      role,
      title: req.title ?? null,
      status: 'idle',
      config,
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsertSession(record);
    const s = new Session(this, record);
    this.#sessions.set(s.id, s);
    if (parent) {
      this.events.emit(
        { sessionId: parent.id, parentChain: parent.parentChain },
        { type: 'child.spawned', childId: s.id, title: record.title },
      );
    }
    this.events.emit({ sessionId: s.id, parentChain: s.parentChain }, { type: 'status', status: 'idle' });
    return s;
  }

  session(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  sessions(): Session[] {
    return [...this.#sessions.values()];
  }

  children(id: string): Session[] {
    return this.sessions().filter((s) => s.parentId === id);
  }

  parentChain(sessionId: string): string[] {
    const chain: string[] = [];
    let cur = this.#sessions.get(sessionId)?.parentId ?? this.store.getSession(sessionId)?.parentId ?? null;
    while (cur && !chain.includes(cur)) {
      chain.push(cur);
      cur = this.#sessions.get(cur)?.parentId ?? this.store.getSession(cur)?.parentId ?? null;
    }
    return chain;
  }

  /** Services handed to tools (session-tree tools use these). */
  services(): Record<string, unknown> {
    return { runtime: this };
  }

  /**
   * Default relay: every message the user writes in a child session is added
   * to the parent's context as a note (and stored), so the parent knows what
   * the user said there.
   */
  onUserMessage(session: Session, message: Message): void {
    if (message.meta?.author !== 'user') return;
    const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    this.#relay(session, 'user_message', `The user wrote in that session: "${text}"`, this.#noteMeta(session, 'relay', text));
  }

  onStatus(): void {}

  /**
   * A child's finished run becomes its report: always written into the
   * parent as a `report` message (ChildNoteMeta), at the parent's next turn
   * boundary if it is running (e.g. inside wait_agents) or right away if idle.
   */
  onRunEnd(session: Session, result: RunResult): void {
    if (!session.parentId || result.reason !== 'completed') return;
    const report = result.text || '(finished without a written report)';
    this.#reports.set(session.id, report);
    const parent = this.session(session.parentId);
    if (!parent) return;
    this.store.appendRelay(this.#relayRecord(parent.id, session.id, 'report', report));
    this.events.emit({ sessionId: parent.id, parentChain: parent.parentChain }, { type: 'child.report', childId: session.id, summary: report.slice(0, 500) });
    parent.addNote('report', `[Report from sub-agent ${label(session)}]\n${report}`, { ...this.#noteMeta(session, 'report', report) });
  }

  /**
   * Record a decision made or changed in a session; it is relayed to the
   * parent like a user message. `by` says who recorded it.
   */
  recordDecision(sessionId: string, decision: string, by: 'user' | 'agent'): void {
    const s = this.session(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);
    this.events.emit({ sessionId, parentChain: s.parentChain }, { type: 'relay', fromSessionId: sessionId, note: `decision: ${decision}` });
    this.#relay(s, 'decision', `Decision ${by === 'user' ? 'made by the user' : 'recorded'} there: ${decision}`, {
      ...this.#noteMeta(s, 'decision', decision),
      by,
    });
  }

  lastReport(sessionId: string): string | undefined {
    return this.#reports.get(sessionId) ?? this.store.listRelays(this.session(sessionId)?.parentId ?? '').filter((r) => r.childId === sessionId && r.kind === 'report').pop()?.text;
  }

  /**
   * Withdraw everything a plugin registered: hooks, tools, and the MCP servers
   * it connected. Hooks and tools are gone immediately; await `stopped` before
   * deleting the plugin's files (server processes are still exiting).
   */
  unregisterSource(source: string): { hooks: number; tools: number; mcpServers: number; stopped: Promise<void> } {
    const servers = [...this.#mcp.values()].filter((m) => m.source === source);
    const stopped = Promise.all(servers.map((m) => m.disconnect())).then(() => undefined);
    return { hooks: this.hooks.unregisterSource(source), tools: this.tools.unregisterSource(source), mcpServers: servers.length, stopped };
  }

  #noteMeta(child: Session, kind: ChildNoteMeta['kind'], text: string): ChildNoteMeta {
    return { author: 'child', kind, fromSessionId: child.id, fromTitle: child.info().title, at: isoNow(), text };
  }

  #relay(child: Session, kind: RelayRecord['kind'], body: string, meta: ChildNoteMeta): void {
    if (!child.parentId) return;
    const parent = this.session(child.parentId);
    if (!parent) return;
    const note = `[From sub-agent ${label(child)}] ${body}`;
    this.store.appendRelay(this.#relayRecord(parent.id, child.id, kind, meta.text));
    parent.addNote('relay', note, { ...meta });
    this.events.emit({ sessionId: parent.id, parentChain: parent.parentChain }, { type: 'relay', fromSessionId: child.id, note });
  }

  #relayRecord(parentId: string, childId: string, kind: RelayRecord['kind'], text: string): RelayRecord {
    return { id: newId('rel'), parentId, childId, kind, text, createdAt: isoNow() };
  }

  /** Traceable records as JSON Lines. */
  exportTraces(filter?: { sessionId?: string }): string {
    return this.tracer.exportJsonl(filter);
  }

  /**
   * Rebuild the session tree from the store after a restart. Sessions caught
   * mid-run become `interrupted` (continue them with `session.resume()`);
   * pending questions and confirmations are kept; queued steers are applied
   * when the session runs again; cost totals are re-seeded from the records.
   */
  restore(): { sessions: number; interrupted: string[]; awaiting: string[] } {
    const interrupted: string[] = [];
    const awaiting: string[] = [];
    const traces = this.store.listTraces();
    const lastInput = new Map<string, number>();
    for (const t of traces) {
      if (t.kind !== 'model' || !t.sessionId || t.status !== 'ok') continue;
      const kind = t.providerId ? this.#providers.get(t.providerId)?.kind : undefined;
      const cached = kind === 'anthropic' ? (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0) : 0;
      lastInput.set(t.sessionId, (t.inputTokens ?? 0) + cached);
    }
    let count = 0;
    for (const rec of this.store.listSessions()) {
      if (this.#sessions.has(rec.id)) continue;
      let status = rec.status;
      const pending = this.store.listPending(rec.id);
      if (pending.length > 0) {
        status = pending.some((p) => p.item.kind === 'confirm') ? 'awaiting_confirm' : 'awaiting_answer';
        awaiting.push(rec.id);
      } else if (status === 'thinking' || status === 'tool' || status === 'queued' || status === 'awaiting_confirm' || status === 'awaiting_answer') {
        status = 'interrupted';
      }
      if (status === 'interrupted') interrupted.push(rec.id);
      const record = status === rec.status ? rec : { ...rec, status, updatedAt: isoNow() };
      if (record !== rec) this.store.upsertSession(record);
      const messages = this.store.listMessages(rec.id).map((m) => {
        if (m.meta?.partial !== true || m.meta.interrupted === true) return m;
        const fixed = { ...m, meta: { ...m.meta, interrupted: true } };
        this.store.updateMessage(fixed); // a stream cut off by the crash
        return fixed;
      });
      const s = new Session(this, record, messages, { lastInputTokens: lastInput.get(rec.id) ?? 0 });
      this.#sessions.set(s.id, s);
      count++;
    }
    this.ledger.seed(
      traces
        .filter((t) => t.costUsd)
        .map((t) => ({ providerId: t.providerId ?? 'unknown', ...(t.sessionId ? { sessionId: t.sessionId } : {}), costUsd: t.costUsd ?? 0 })),
    );
    for (const s of this.#sessions.values()) {
      this.events.emit({ sessionId: s.id, parentChain: s.parentChain }, { type: 'status', status: s.status });
    }
    return { sessions: count, interrupted, awaiting };
  }

  /**
   * Start an MCP server (stdio) and add its tools under `opts.source`
   * (default `mcp:<name>`); `unregisterSource(source)` or `disconnect()`
   * removes the tools and stops the server.
   */
  async connectMcp(
    config: McpServerConfig,
    opts: { source?: string } = {},
  ): Promise<{ tools: string[]; source: string; disconnect: () => Promise<void> }> {
    if (this.#mcp.has(config.name)) throw new Error(`MCP server "${config.name}" is already connected`);
    const h = await connectMcp(this.tools, this.tracer, config, opts);
    // Resolves when the server process has exited.
    const disconnect = () => {
      this.#mcp.delete(config.name);
      return h.disconnect();
    };
    this.#mcp.set(config.name, { client: h.client, source: h.source, disconnect });
    return { tools: h.tools, source: h.source, disconnect };
  }

  /** Stop all runs (they become `interrupted`, resumable after restart), stop MCP servers, close the store. */
  async close(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => s.shutdown()));
    await Promise.all([...this.#mcp.values()].map((m) => m.disconnect()));
    this.store.close();
  }
}
