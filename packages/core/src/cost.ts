// Cost estimation and spending limits.
// Prices are data (USD per million tokens) and can be overridden per deployment.
import { BUILTIN_CATALOG } from './catalog/builtin.ts';
import { pricesFromCatalog } from './catalog/catalog.ts';
import type { Usage } from './types.ts';
import { abortError } from './util.ts';

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** True when the default value has not been checked against the vendor's price list. */
  unverified?: boolean;
  /**
   * No price is known for this model: the row is a stand-in (FALLBACK_PRICE, a kind's `*` fallback, a catalog
   * model without an official price). Calls of such a model count against no limit and their cost is not kept
   * as a number (shown 「未计价」): a made-up price stopped runs on the company gateway (he, 2026-11-12).
   */
  unpriced?: boolean;
  /** Context window in tokens (only from an exact model entry; never guessed from a `*` row). */
  contextWindow?: number;
  /** Most output tokens one call may ask for (the catalog's maxOutput; only from an exact model entry). */
  maxOutput?: number;
  /** Higher rates when the prompt is longer than `above` input tokens. */
  longContext?: { above: number; input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/** providerId, catalog provider id or providerKind -> model -> price. Lookup tries the id, its catalog id, the kind, then '*'. */
export type PriceTable = Record<string, Record<string, ModelPrice>>;

/**
 * Defaults: generated from the model catalog (catalog/builtin.ts, official list
 * prices with their sources), one table per catalog provider id and per kind,
 * plus deliberately high rows for models without a price.
 */
export const DEFAULT_PRICES: PriceTable = pricesFromCatalog(BUILTIN_CATALOG);

/** Used when nothing in the price table matches: high on purpose. */
export const FALLBACK_PRICE: ModelPrice = { input: 10, output: 50, unverified: true, unpriced: true };

export interface Limits {
  globalUsd?: number;
  perSessionUsd?: number;
  /** One run = from a user message until the agent stops. */
  perRunUsd?: number;
  /** Worst-case cost of a single model call (input estimate + maxTokens of output). */
  perCallUsd?: number;
}

export interface BudgetConfig extends Limits {
  /** Fraction of a limit at which a warning event is emitted. Default 0.8. */
  warnAt?: number;
  /** Extra limits per provider id (e.g. a stricter cap for one paid endpoint). */
  perProvider?: Record<string, Limits>;
}

export interface CostScope {
  providerId: string;
  providerKind: string;
  model: string;
  sessionId: string;
  runId: string;
}

export type BudgetCheck =
  | { ok: true }
  | { ok: false; scope: string; spentUsd: number; limitUsd: number; /** The worst case of the call not started. */ nextUsd: number; message: string };

/** Worst-case cost held for a call that has passed the check and not been recorded yet. */
export interface Reservation {
  readonly usd: number;
  /** Give the held amount back (idempotent). `record()` does this for its scope's reservation. */
  release(): void;
}

/**
 * `wait`: the limit is only reached because of calls still running (counted at
 * their worst case); once they are recorded at what they really cost, the call
 * may fit. Wait with `released()` and try again.
 */
export type ReserveResult = ({ ok: true } & Reservation) | (Extract<BudgetCheck, { ok: false }> & { wait: boolean });

export interface CostRecord {
  /** 0 for a call of a model without a price (`unpriced`). */
  costUsd: number;
  /** The model has no price: nothing was counted. */
  unpriced?: true;
  /** `unpriced` on a total: calls without a price were made in it and are not in spentUsd. */
  totals: { scope: 'call' | 'run' | 'session' | 'global'; spentUsd: number; limitUsd?: number; warning: boolean; unpriced?: true }[];
}

export class CostLedger {
  #prices: PriceTable;
  #budget: BudgetConfig;
  #global = 0;
  readonly #byProvider = new Map<string, number>();
  readonly #bySession = new Map<string, number>();
  readonly #byRun = new Map<string, number>();
  readonly #byProviderSession = new Map<string, number>();
  readonly #byProviderRun = new Map<string, number>();
  /** Where calls without a price were made: runs, sessions, anywhere. */
  readonly #unpricedRuns = new Set<string>();
  readonly #unpricedSessions = new Set<string>();
  #unpricedAny = false;
  /** Calls in flight: their worst case counts as spent until they are recorded. */
  readonly #held = new Set<{ scope: CostScope; usd: number }>();
  #onRelease: (() => void)[] = [];
  /** providerId -> model -> context window, from the settings. */
  readonly #windows = new Map<string, Record<string, number>>();
  /** providerId -> model -> most output tokens, from the settings (what the provider's model list said). */
  readonly #outputs = new Map<string, Record<string, number>>();
  /** providerId -> the catalog provider it was set up from (ProviderConfig.catalogId). */
  readonly #catalogIds = new Map<string, string>();

  constructor(prices: PriceTable = DEFAULT_PRICES, budget: BudgetConfig = {}) {
    this.#prices = prices;
    this.#budget = budget;
  }

  /**
   * Price for a model: exact model under the provider id, then under the
   * provider kind; then the `*` rows of those; then the table-wide `*`
   * entry; finally a deliberately high fallback, so an unpriced model can
   * never make the limits look free.
   */
  price(providerId: string, providerKind: string, model: string): ModelPrice {
    const tables = this.#tables(providerId, providerKind);
    for (const t of tables) if (t?.[model]) return t[model]!;
    for (const t of tables) if (t?.['*']) return t['*']!;
    return this.#prices['*']?.['*'] ?? FALLBACK_PRICE;
  }

  /**
   * Context window of a model: what the settings give for this provider and
   * model first, then the price table's exact entry (provider id, then kind), else null.
   */
  contextWindow(providerId: string, providerKind: string, model: string): number | null {
    const set = this.#windows.get(providerId)?.[model];
    if (set) return set;
    for (const t of this.#tables(providerId, providerKind)) {
      const w = t?.[model]?.contextWindow;
      if (w) return w;
    }
    return null;
  }

  /**
   * The most output tokens one call to a model may ask for: what the settings give for this provider and model
   * first (the provider's own model list), then the price table's exact entry (the catalog), else null. Never
   * guessed from a `*` row or a similar name: a number the provider does not accept fails the call.
   */
  maxOutput(providerId: string, providerKind: string, model: string): number | null {
    const set = this.#outputs.get(providerId)?.[model];
    if (set) return set;
    for (const t of this.#tables(providerId, providerKind)) {
      const n = t?.[model]?.maxOutput;
      if (n) return n;
    }
    return null;
  }

  /** Most output tokens per model set for one provider (replaces the previous map; entries not a positive whole number are left out). */
  setMaxOutputs(providerId: string, outputs: Record<string, number>): void {
    const ok = Object.fromEntries(Object.entries(outputs).filter(([, n]) => Number.isInteger(n) && n > 0));
    if (Object.keys(ok).length) this.#outputs.set(providerId, ok);
    else this.#outputs.delete(providerId);
  }

  /**
   * What the price table knows of a model's context window, ignoring the
   * settings (to pre-fill a form): the provider kind's exact entry, then an
   * exact entry under any provider (the same model behind a gateway), else null.
   */
  knownContextWindow(providerKind: string, model: string, catalogId?: string): number | null {
    const w = (catalogId ? this.#prices[catalogId]?.[model]?.contextWindow : undefined) ?? this.#prices[providerKind]?.[model]?.contextWindow;
    if (w) return w;
    for (const t of Object.values(this.#prices)) {
      const any = t[model]?.contextWindow;
      if (any) return any;
    }
    return null;
  }

  /**
   * The known context window of a model by its name, also when a relay spells
   * it differently: the exact name first (catalog provider, then kind, then any
   * provider), then ignoring case, then without a vendor prefix ("vendor/model").
   * `how` says which: 'exact', or 'name' (matched by name; the form marks it and
   * `matched` says which catalog model it is). null when nothing matches.
   */
  matchContextWindow(providerKind: string, model: string, catalogId?: string): { contextWindow: number; matched: string; how: 'exact' | 'name' } | null {
    const exact = this.knownContextWindow(providerKind, model, catalogId);
    if (exact) return { contextWindow: exact, matched: model, how: 'exact' };
    const norm = (s: string) => s.toLowerCase().trim();
    const bare = (s: string) => norm(s).replace(/^.*\//, '');
    const tables = [catalogId ? this.#prices[catalogId] : undefined, this.#prices[providerKind], ...Object.values(this.#prices)];
    for (const same of [(a: string, b: string) => norm(a) === norm(b), (a: string, b: string) => bare(a) === bare(b)]) {
      for (const t of tables) {
        for (const [id, row] of Object.entries(t ?? {})) {
          if (id !== '*' && row.contextWindow && same(id, model)) return { contextWindow: row.contextWindow, matched: id, how: 'name' };
        }
      }
    }
    return null;
  }

  /** The catalog provider a configured provider was set up from, if any. */
  catalogIdOf(providerId: string): string | undefined {
    return this.#catalogIds.get(providerId);
  }

  /** Which catalog provider each configured provider was set up from (replaces the previous map). */
  setCatalogIds(ids: Record<string, string>): void {
    this.#catalogIds.clear();
    for (const [id, c] of Object.entries(ids)) if (c) this.#catalogIds.set(id, c);
  }

  #tables(providerId: string, providerKind: string): (Record<string, ModelPrice> | undefined)[] {
    const c = this.#catalogIds.get(providerId);
    return [this.#prices[providerId], c ? this.#prices[c] : undefined, this.#prices[providerKind]];
  }

  /**
   * Context windows set in the settings for one provider (model -> tokens),
   * replacing what was set before; an empty map clears them. Entries that are
   * not a positive whole number are left out and named in the result.
   */
  setContextWindows(providerId: string, windows: Record<string, number>): string[] {
    const ok: Record<string, number> = {};
    const bad: string[] = [];
    for (const [model, n] of Object.entries(windows)) {
      if (Number.isInteger(n) && n > 0) ok[model] = n;
      else bad.push(model);
    }
    if (Object.keys(ok).length) this.#windows.set(providerId, ok);
    else this.#windows.delete(providerId);
    return bad;
  }

  estimate(scope: Pick<CostScope, 'providerId' | 'providerKind' | 'model'>, usage: Usage): number {
    const base = this.price(scope.providerId, scope.providerKind, scope.model);
    const prompt = usage.inputTokens + (scope.providerKind === 'anthropic' ? (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : 0);
    const p = base.longContext && prompt > base.longContext.above ? { ...base, ...base.longContext } : base;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    // Anthropic reports cached tokens separately from input_tokens; OpenAI-style
    // APIs include them in prompt_tokens. Charge the uncached remainder at the input price.
    const plainInput = scope.providerKind === 'anthropic' ? usage.inputTokens : Math.max(0, usage.inputTokens - cacheRead);
    return (
      (plainInput * p.input +
        usage.outputTokens * p.output +
        cacheRead * (p.cacheRead ?? p.input) +
        cacheWrite * (p.cacheWrite ?? p.input)) /
      1_000_000
    );
  }

  /** Whether a model has a known price (not a stand-in row, see ModelPrice.unpriced). */
  priced(scope: Pick<CostScope, 'providerId' | 'providerKind' | 'model'>): boolean {
    return this.price(scope.providerId, scope.providerKind, scope.model).unpriced !== true;
  }

  /** The worst case of a call as counted against limits: 0 for a model without a price. */
  worstCase(scope: Pick<CostScope, 'providerId' | 'providerKind' | 'model'>, estInputTokens: number, maxTokens: number): number {
    return this.priced(scope) ? this.estimate(scope, { inputTokens: estInputTokens, outputTokens: maxTokens }) : 0;
  }

  /** Whether calls without a price were made in a session (or anywhere, without one). */
  hasUnpriced(sessionId?: string): boolean {
    return sessionId === undefined ? this.#unpricedAny : this.#unpricedSessions.has(sessionId);
  }

  /**
   * Seed totals from persisted history (after a restart). `unpriced`: a record of a model without a price (also
   * an old one written at the stand-in price, before such calls stopped counting): marked, not added.
   */
  seed(entries: { providerId: string; sessionId?: string; costUsd: number; unpriced?: boolean }[]): void {
    for (const e of entries) {
      if (e.unpriced) {
        this.#unpricedAny = true;
        if (e.sessionId) this.#unpricedSessions.add(e.sessionId);
        continue;
      }
      this.#global += e.costUsd;
      add(this.#byProvider, e.providerId, e.costUsd);
      if (e.sessionId) {
        add(this.#bySession, e.sessionId, e.costUsd);
        add(this.#byProviderSession, `${e.providerId}|${e.sessionId}`, e.costUsd);
      }
    }
  }

  /**
   * Check the limits and, when the call may start, hold its worst-case cost
   * until `record()` (or `release()` when the call fails or is cancelled).
   * Many sessions start calls at the same time: without the hold they would
   * all see the same total and pass together.
   */
  reserve(scope: CostScope, estInputTokens: number, maxTokens: number): ReserveResult {
    // a model without a price counts nothing: no limit stops it, nothing is held
    if (!this.priced(scope)) return { ok: true, usd: 0, release: () => undefined };
    const check = this.#check(scope, estInputTokens, maxTokens);
    // only what is spent counts: calls still running never make another wait
    if (!check.ok) return { ...check, wait: false };
    const entry = { scope, usd: this.estimate(scope, { inputTokens: estInputTokens, outputTokens: maxTokens }) };
    this.#held.add(entry);
    return { ok: true, usd: entry.usd, release: () => this.#release(entry) };
  }

  /** Resolves the next time a held amount is given back or recorded (rejects on abort). */
  released(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.#onRelease = this.#onRelease.filter((f) => f !== done);
        reject(abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#onRelease.push(done);
    });
  }

  #release(entry: { scope: CostScope; usd: number }): void {
    if (!this.#held.delete(entry)) return;
    const waiting = this.#onRelease;
    this.#onRelease = [];
    for (const f of waiting) f();
  }

  /** Worst-case cost held by calls in flight (all providers). */
  get heldUsd(): number {
    let sum = 0;
    for (const h of this.#held) sum += h.usd;
    return sum;
  }

  /** Check limits before a call: stopped once what is spent has reached one (the per-call cap still takes the call's worst case). */
  precheck(scope: CostScope, estInputTokens: number, maxTokens: number): BudgetCheck {
    return this.#check(scope, estInputTokens, maxTokens);
  }

  #check(scope: CostScope, estInputTokens: number, maxTokens: number): BudgetCheck {
    // Policy: a call is not started once what is already spent has reached a limit (a model without a price adds
    // nothing). What the next call might cost is not counted in, nor the calls still running: a limit can be
    // passed by the calls that started below it (about one step per conversation running). Counting the worst
    // case (the whole answer written out, 384,000 tokens on some models) stopped a 0.10 limit at 0.05 spent
    // before a single request.
    if (!this.priced(scope)) return { ok: true };
    const worst = this.estimate(scope, { inputTokens: estInputTokens, outputTokens: maxTokens });
    const groups = [
      ['all', this.#budget],
      [scope.providerId, this.#budget.perProvider?.[scope.providerId]],
    ] as const;
    for (const [label, limits] of groups) {
      if (!limits) continue;
      const checks: [string, number, number | undefined][] = [
        ['global', this.#recorded(label, 'global', scope), limits.globalUsd],
        ['session', this.#recorded(label, 'session', scope), limits.perSessionUsd],
        ['run', this.#recorded(label, 'run', scope), limits.perRunUsd],
      ];
      for (const [kind, spent, limit] of checks) {
        if (limit !== undefined && spent >= limit) {
          return {
            ok: false,
            scope: `${label}:${kind}`,
            spentUsd: spent,
            limitUsd: limit,
            nextUsd: worst,
            message: `spending limit ${label}:${kind} reached: spent $${spent.toFixed(4)} of $${limit.toFixed(2)}`,
          };
        }
      }
    }
    for (const [label, limits] of groups) {
      const lim = limits?.perCallUsd;
      if (lim !== undefined && worst > lim) {
        return {
          ok: false,
          scope: `${label}:call`,
          spentUsd: 0,
          limitUsd: lim,
          nextUsd: worst,
          message: `single call could cost up to $${worst.toFixed(4)}, above the per-call limit $${lim.toFixed(2)} (${label}); lower maxTokens or shorten the context`,
        };
      }
    }
    return { ok: true };
  }

  record(scope: CostScope, usage: Usage): CostRecord {
    // the call is done: its hold is replaced by what it really cost
    for (const h of [...this.#held]) if (h.scope === scope) this.#release(h);
    const unpriced = !this.priced(scope);
    const cost = unpriced ? 0 : this.estimate(scope, usage);
    if (unpriced) {
      this.#unpricedAny = true;
      this.#unpricedSessions.add(scope.sessionId);
      this.#unpricedRuns.add(scope.runId);
    }
    this.#global += cost;
    add(this.#byProvider, scope.providerId, cost);
    add(this.#bySession, scope.sessionId, cost);
    add(this.#byRun, scope.runId, cost);
    add(this.#byProviderSession, `${scope.providerId}|${scope.sessionId}`, cost);
    add(this.#byProviderRun, `${scope.providerId}|${scope.runId}`, cost);
    const warnAt = this.#budget.warnAt ?? 0.8;
    const w = (spent: number, limit?: number) => limit !== undefined && spent >= limit * warnAt;
    const b = this.#budget;
    const mark = (on: boolean) => (on ? { unpriced: true as const } : {});
    return {
      costUsd: cost,
      ...mark(unpriced),
      totals: [
        { scope: 'call', spentUsd: cost, ...(b.perCallUsd !== undefined ? { limitUsd: b.perCallUsd } : {}), warning: w(cost, b.perCallUsd), ...mark(unpriced) },
        { scope: 'run', spentUsd: this.#byRun.get(scope.runId) ?? 0, ...(b.perRunUsd !== undefined ? { limitUsd: b.perRunUsd } : {}), warning: w(this.#byRun.get(scope.runId) ?? 0, b.perRunUsd), ...mark(this.#unpricedRuns.has(scope.runId)) },
        { scope: 'session', spentUsd: this.#bySession.get(scope.sessionId) ?? 0, ...(b.perSessionUsd !== undefined ? { limitUsd: b.perSessionUsd } : {}), warning: w(this.#bySession.get(scope.sessionId) ?? 0, b.perSessionUsd), ...mark(this.#unpricedSessions.has(scope.sessionId)) },
        { scope: 'global', spentUsd: this.#global, ...(b.globalUsd !== undefined ? { limitUsd: b.globalUsd } : {}), warning: w(this.#global, b.globalUsd), ...mark(this.#unpricedAny) },
      ],
    };
  }

  /** Change the spending limits while running (totals so far are kept). */
  setBudget(budget: BudgetConfig): void {
    this.#budget = budget;
  }

  /** Change the price table while running (only future calls use it). */
  setPrices(prices: PriceTable): void {
    this.#prices = prices;
  }

  get budget(): BudgetConfig {
    return this.#budget;
  }

  get globalUsd(): number {
    return this.#global;
  }

  sessionUsd(sessionId: string): number {
    return this.#bySession.get(sessionId) ?? 0;
  }

  providerUsd(providerId: string): number {
    return this.#byProvider.get(providerId) ?? 0;
  }

  #recorded(label: string, kind: 'global' | 'session' | 'run', s: CostScope): number {
    if (label === 'all') {
      if (kind === 'global') return this.#global;
      if (kind === 'session') return this.#bySession.get(s.sessionId) ?? 0;
      return this.#byRun.get(s.runId) ?? 0;
    }
    if (kind === 'global') return this.#byProvider.get(label) ?? 0;
    if (kind === 'session') return this.#byProviderSession.get(`${label}|${s.sessionId}`) ?? 0;
    return this.#byProviderRun.get(`${label}|${s.runId}`) ?? 0;
  }
}

function add(map: Map<string, number>, key: string, v: number): void {
  map.set(key, (map.get(key) ?? 0) + v);
}
