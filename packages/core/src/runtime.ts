// Runtime: owns the session tree and everything sessions share
// (providers, rate limiters, cost ledger, hooks, tools, store, event bus).
import { CostLedger, DEFAULT_PRICES, type BudgetConfig, type PriceTable } from './cost.ts';
import { EventBus, isoNow } from './events.ts';
import { HookRegistry } from './hooks.ts';
import { RateLimiter, type LimiterConfig } from './limiter.ts';
import type { Provider } from './providers/types.ts';
import { Session } from './session.ts';
import { MemoryStore } from './store/memory.ts';
import type { SessionConfig, SessionRecord, Store } from './store/types.ts';
import { fileTools } from './tools/fs-tools.ts';
import { ToolRegistry, type FileExtractor, type Tool } from './tools/types.ts';
import { Tracer } from './trace.ts';
import type { AgentRole, CreateSessionRequest, Message, SessionStatus } from './types.ts';
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
  /** Built-in tools to register. Default: the file tools. */
  tools?: Tool[];
  extractors?: FileExtractor[];
  /** Default working folder for sessions. */
  cwd?: string;
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

  constructor(opts: RuntimeOptions) {
    this.#opts = opts;
    this.store = opts.store ?? new MemoryStore();
    this.tracer = new Tracer(this.store, this.events);
    this.ledger = new CostLedger(opts.prices ?? DEFAULT_PRICES, opts.budget ?? {});
    this.extractors = [...(opts.extractors ?? [])];
    for (const p of opts.providers) this.addProvider(p, opts.limits?.[p.id]);
    for (const t of opts.tools ?? fileTools) this.tools.register(t, 'core');
  }

  addProvider(p: Provider, limits?: LimiterConfig): void {
    this.#providers.set(p.id, p);
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
      ...(req.tools ? { tools: req.tools } : {}),
    };
    this.provider(config.providerId); // fail fast
    const record: SessionRecord = {
      id: newId('ses'),
      parentId: parent?.id ?? null,
      role,
      title: req.title ?? (role === 'top' ? 'Top-level agent' : 'Agent'),
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

  onUserMessage(): void {
    // Relay to the parent is wired in the session-tree module.
  }

  onStatus(): void {}

  /** Traceable records as JSON Lines. */
  exportTraces(filter?: { sessionId?: string }): string {
    return this.tracer.exportJsonl(filter);
  }

  close(): void {
    for (const s of this.#sessions.values()) s.abort('runtime closed');
    this.store.close();
  }
}
