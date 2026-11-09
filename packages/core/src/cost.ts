// Cost estimation and spending limits.
// Prices are data (USD per million tokens) and can be overridden per deployment.
import type { Usage } from './types.ts';

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** True when the default value has not been checked against the vendor's price list. */
  unverified?: boolean;
}

/** providerKind or providerId -> model -> price. Lookup tries id first, then kind, then '*'. */
export type PriceTable = Record<string, Record<string, ModelPrice>>;

/**
 * Defaults. Anthropic values come from the published list price; values
 * marked `unverified` are placeholders until checked.
 */
export const DEFAULT_PRICES: PriceTable = {
  anthropic: {
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    '*': { input: 10, output: 50, unverified: true }, // unknown Claude model: assume the top tier
  },
  'openai-compatible': {
    'deepseek-flash': { input: 0.3, output: 1.2, cacheRead: 0.03, unverified: true },
    'deepseek-v4-pro': { input: 1, output: 4, cacheRead: 0.1, unverified: true },
    '*': { input: 5, output: 20, unverified: true },
  },
};

/** Used when nothing in the price table matches: high on purpose. */
export const FALLBACK_PRICE: ModelPrice = { input: 10, output: 50, unverified: true };

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
  | { ok: false; scope: string; spentUsd: number; limitUsd: number; message: string };

export interface CostRecord {
  costUsd: number;
  totals: { scope: 'call' | 'run' | 'session' | 'global'; spentUsd: number; limitUsd?: number; warning: boolean }[];
}

export class CostLedger {
  readonly #prices: PriceTable;
  readonly #budget: BudgetConfig;
  #global = 0;
  readonly #byProvider = new Map<string, number>();
  readonly #bySession = new Map<string, number>();
  readonly #byRun = new Map<string, number>();
  readonly #byProviderSession = new Map<string, number>();
  readonly #byProviderRun = new Map<string, number>();

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
    const tables = [this.#prices[providerId], this.#prices[providerKind]];
    for (const t of tables) if (t?.[model]) return t[model]!;
    for (const t of tables) if (t?.['*']) return t['*']!;
    return this.#prices['*']?.['*'] ?? FALLBACK_PRICE;
  }

  estimate(scope: Pick<CostScope, 'providerId' | 'providerKind' | 'model'>, usage: Usage): number {
    const p = this.price(scope.providerId, scope.providerKind, scope.model);
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

  /** Seed totals from persisted history (after a restart). */
  seed(entries: { providerId: string; sessionId?: string; costUsd: number }[]): void {
    for (const e of entries) {
      this.#global += e.costUsd;
      add(this.#byProvider, e.providerId, e.costUsd);
      if (e.sessionId) {
        add(this.#bySession, e.sessionId, e.costUsd);
        add(this.#byProviderSession, `${e.providerId}|${e.sessionId}`, e.costUsd);
      }
    }
  }

  /** Check limits before a call, using a worst-case estimate of its cost. */
  precheck(scope: CostScope, estInputTokens: number, maxTokens: number): BudgetCheck {
    // Policy: never start a call that could push any total past its limit.
    const worst = this.estimate(scope, { inputTokens: estInputTokens, outputTokens: maxTokens });
    const groups = [
      ['all', this.#budget],
      [scope.providerId, this.#budget.perProvider?.[scope.providerId]],
    ] as const;
    for (const [label, limits] of groups) {
      if (!limits) continue;
      const checks: [string, number, number | undefined][] = [
        ['global', this.#scopeTotal(label, 'global', scope), limits.globalUsd],
        ['session', this.#scopeTotal(label, 'session', scope), limits.perSessionUsd],
        ['run', this.#scopeTotal(label, 'run', scope), limits.perRunUsd],
      ];
      for (const [kind, spent, limit] of checks) {
        if (limit !== undefined && spent + worst > limit) {
          return {
            ok: false,
            scope: `${label}:${kind}`,
            spentUsd: spent,
            limitUsd: limit,
            message: `spending limit ${label}:${kind} reached: spent $${spent.toFixed(4)} of $${limit.toFixed(2)}, the next call could cost up to $${worst.toFixed(4)}`,
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
          message: `single call could cost up to $${worst.toFixed(4)}, above the per-call limit $${lim.toFixed(2)} (${label}); lower maxTokens or shorten the context`,
        };
      }
    }
    return { ok: true };
  }

  record(scope: CostScope, usage: Usage): CostRecord {
    const cost = this.estimate(scope, usage);
    this.#global += cost;
    add(this.#byProvider, scope.providerId, cost);
    add(this.#bySession, scope.sessionId, cost);
    add(this.#byRun, scope.runId, cost);
    add(this.#byProviderSession, `${scope.providerId}|${scope.sessionId}`, cost);
    add(this.#byProviderRun, `${scope.providerId}|${scope.runId}`, cost);
    const warnAt = this.#budget.warnAt ?? 0.8;
    const w = (spent: number, limit?: number) => limit !== undefined && spent >= limit * warnAt;
    const b = this.#budget;
    return {
      costUsd: cost,
      totals: [
        { scope: 'call', spentUsd: cost, ...(b.perCallUsd !== undefined ? { limitUsd: b.perCallUsd } : {}), warning: w(cost, b.perCallUsd) },
        { scope: 'run', spentUsd: this.#byRun.get(scope.runId) ?? 0, ...(b.perRunUsd !== undefined ? { limitUsd: b.perRunUsd } : {}), warning: w(this.#byRun.get(scope.runId) ?? 0, b.perRunUsd) },
        { scope: 'session', spentUsd: this.#bySession.get(scope.sessionId) ?? 0, ...(b.perSessionUsd !== undefined ? { limitUsd: b.perSessionUsd } : {}), warning: w(this.#bySession.get(scope.sessionId) ?? 0, b.perSessionUsd) },
        { scope: 'global', spentUsd: this.#global, ...(b.globalUsd !== undefined ? { limitUsd: b.globalUsd } : {}), warning: w(this.#global, b.globalUsd) },
      ],
    };
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

  #scopeTotal(label: string, kind: 'global' | 'session' | 'run', s: CostScope): number {
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
