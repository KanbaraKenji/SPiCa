// Plugins use the models the user has set up (MCP sampling, server → client
// "sampling/createMessage"): a plugin needs no key of its own, the cost goes to
// the user's budget. Only plugins whose manifest asks for it get it (the plugin
// manager passes McpServerConfig.sampling); each has a daily limit and a small
// rate limit. A sampling call has no tools and no conversation: the model can
// only answer text, and the answer goes to that plugin alone.
import { isoNow } from './events.ts';
import { RateLimiter } from './limiter.ts';
import type { HostModel } from './settings-tools.ts';
import type { Runtime } from './runtime.ts';
import type { Message } from './types.ts';
import { estimateTokens, newId } from './util.ts';

/** What a plugin may do with the user's models (set by the plugin manager from the manifest and the user's settings). */
export interface SamplingGrant {
  pluginId: string;
  /** Spending limit per day for this plugin, in USD. Default 0.5. */
  maxUsdPerDay?: number;
}

/** A refusal the plugin can tell apart: JSON-RPC error with data.code. */
export class SamplingError extends Error {
  override name = 'SamplingError';
  readonly code: string;
  constructor(code: 'invalid' | 'no_model' | 'model_not_configured' | 'budget' | 'rate_limited' | 'failed', message: string) {
    super(message);
    this.code = code;
  }
}

interface SamplingMessage {
  role: 'user' | 'assistant';
  content: { type: string; text?: string } | { type: string; text?: string }[];
}

interface CreateMessageParams {
  messages: SamplingMessage[];
  systemPrompt?: string;
  maxTokens: number;
  temperature?: number;
  modelPreferences?: { hints?: { name?: string }[]; intelligencePriority?: number };
  includeContext?: string;
  tools?: unknown[];
  _meta?: { spica?: { requireModel?: boolean } };
}

const DEFAULT_DAILY_USD = 0.5;
const STRONG = 0.7;

export class PluginSampler {
  readonly #rt: Runtime;
  readonly #limiters = new Map<string, RateLimiter>();
  /** pluginId → { day, usd } spent today (seeded from the traceable records after a restart). */
  readonly #spent = new Map<string, { day: string; usd: number }>();

  constructor(rt: Runtime) {
    this.#rt = rt;
  }

  /** Spent today by a plugin through sampling, in USD. */
  spentToday(pluginId: string): number {
    return this.#today(pluginId).usd;
  }

  #today(pluginId: string): { day: string; usd: number } {
    const day = isoNow().slice(0, 10);
    let s = this.#spent.get(pluginId);
    if (!s || s.day !== day) {
      const usd = this.#rt.store
        .listTraces()
        .filter((t) => t.kind === 'model' && t.initiator === `plugin:${pluginId}` && t.startedAt.slice(0, 10) === day)
        .reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
      s = { day, usd };
      this.#spent.set(pluginId, s);
    }
    return s;
  }

  /** Which configured model to use: a hint that names one, else strong / default. */
  async #choose(p: CreateMessageParams): Promise<{ providerId: string; model: string; fallback?: { requested: string } }> {
    const d = this.#rt.defaults;
    if (!d.providerId || !this.#rt.providerIds.includes(d.providerId) || !d.model) {
      throw new SamplingError('no_model', 'no model is set up yet: the user has to configure one in the settings first');
    }
    const hints = (p.modelPreferences?.hints ?? []).map((h) => String(h?.name ?? '').trim().toLowerCase()).filter(Boolean);
    const named = hints.filter((h) => h !== 'strong' && h !== 'default');
    if (named.length > 0) {
      // the models the user configured (the window knows all of them; without it, the defaults)
      let all: { providerId: string; model: string }[] = [];
      try {
        const listed = ((await this.#rt.settingsBridge?.host('models.list')) ?? []) as HostModel[];
        all = listed.flatMap((m) => [{ providerId: m.id, model: m.model }, ...(m.strongModel ? [{ providerId: m.id, model: m.strongModel }] : [])]);
      } catch {
        // no window: only the defaults are known
      }
      all.push({ providerId: d.providerId, model: d.model }, ...(d.strongModel ? [{ providerId: d.providerId, model: d.strongModel }] : []));
      const usable = all.filter((c) => c.model && this.#rt.providerIds.includes(c.providerId));
      for (const h of named) {
        const hit = usable.find((c) => c.model.toLowerCase() === h) ?? usable.find((c) => c.model.toLowerCase().includes(h));
        if (hit) return hit;
      }
      if (p._meta?.spica?.requireModel === true) {
        throw new SamplingError('model_not_configured', `none of the requested models (${named.join(', ')}) is set up; ask the user to configure one`);
      }
      const base = this.#strongOrDefault(p, hints);
      return { ...base, fallback: { requested: named.join(', ') } };
    }
    return this.#strongOrDefault(p, hints);
  }

  #strongOrDefault(p: CreateMessageParams, hints: string[]): { providerId: string; model: string } {
    const d = this.#rt.defaults;
    const strong = hints.includes('strong') || (p.modelPreferences?.intelligencePriority ?? 0) >= STRONG;
    return { providerId: d.providerId, model: strong && d.strongModel ? d.strongModel : d.model };
  }

  /** Answer one sampling/createMessage request of a plugin's server. */
  async createMessage(grant: SamplingGrant, raw: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const p = (raw ?? {}) as CreateMessageParams;
    if (!Array.isArray(p.messages) || p.messages.length === 0) throw new SamplingError('invalid', 'messages are required');
    if (Array.isArray(p.tools) && p.tools.length > 0) throw new SamplingError('invalid', 'tools are not available when sampling');
    const messages: Message[] = p.messages.map((m, i) => {
      const parts = Array.isArray(m.content) ? m.content : [m.content];
      if (parts.some((c) => c?.type !== 'text')) throw new SamplingError('invalid', 'only text content can be sampled');
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      return {
        id: `sample-${i}`,
        sessionId: `plugin:${grant.pluginId}`,
        seq: i + 1,
        role,
        kind: role,
        content: [{ type: 'text', text: parts.map((c) => c.text ?? '').join('') }],
        createdAt: '',
      };
    });
    const d = this.#rt.defaults;
    const maxTokens = Math.max(1, Math.min(Number.isFinite(p.maxTokens) ? Math.floor(p.maxTokens) : d.maxTokens, d.maxTokens));
    const choice = await this.#choose(p);
    const provider = this.#rt.provider(choice.providerId);
    const system = typeof p.systemPrompt === 'string' ? p.systemPrompt : '';

    // the plugin's own limits first, then the user's budget (held at the worst case while it runs)
    const lim = this.#limiter(grant.pluginId);
    const lease = await lim.acquire({ signal });
    const callId = newId('smp');
    const scope = { providerId: choice.providerId, providerKind: provider.kind, model: choice.model, sessionId: `plugin:${grant.pluginId}`, runId: callId };
    const estIn = estimateTokens(system + JSON.stringify(messages));
    const worst = this.#rt.ledger.estimate(scope, { inputTokens: estIn, outputTokens: maxTokens });
    const cap = grant.maxUsdPerDay ?? DEFAULT_DAILY_USD;
    const today = this.#today(grant.pluginId);
    if (today.usd + worst > cap) {
      lease.release();
      throw new SamplingError('budget', `this plugin's model budget for today is used up ($${today.usd.toFixed(4)} of $${cap.toFixed(2)}; the next call could cost up to $${worst.toFixed(4)})`);
    }
    const held = this.#rt.ledger.reserve(scope, estIn, maxTokens);
    if (!held.ok) {
      lease.release();
      throw new SamplingError('budget', held.message);
    }
    const trace = this.#rt.tracer.start({
      kind: 'model',
      sessionId: null,
      parentChain: [],
      initiator: `plugin:${grant.pluginId}`,
      target: provider.traceTarget,
      providerId: choice.providerId,
      model: choice.model,
    });
    const provLease = await this.#rt.limiter(choice.providerId).acquire({ signal });
    const info = { attempts: 0 };
    try {
      let response: import('./providers/types.ts').ModelResponse | undefined;
      for await (const ev of provider.stream({ model: choice.model, system, messages, tools: [], maxTokens, ...(typeof p.temperature === 'number' ? { temperature: p.temperature } : {}) }, { signal, info })) {
        if (ev.type === 'response') response = ev.response;
      }
      if (!response) throw new Error('the model sent no answer');
      const cost = this.#rt.ledger.record(scope, response.usage).costUsd;
      today.usd += cost;
      trace.finish({
        status: 'ok',
        attempts: info.attempts,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        costUsd: cost,
        model: response.model || choice.model,
      });
      const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return {
        role: 'assistant',
        content: { type: 'text', text },
        model: choice.model,
        stopReason: response.stopReason === 'max_tokens' ? 'maxTokens' : 'endTurn',
        // a plugin that needs a particular model can tell it got another one
        ...(choice.fallback ? { _meta: { spica: { fallback: true, requested: choice.fallback.requested } } } : {}),
      };
    } catch (err) {
      held.release();
      const message = this.#rt.redact(err instanceof Error ? err.message : String(err));
      trace.finish({ status: signal.aborted ? 'aborted' : 'error', attempts: info.attempts, error: message });
      throw err instanceof SamplingError ? err : new SamplingError('failed', message);
    } finally {
      provLease.release();
      lease.release();
    }
  }

  #limiter(pluginId: string): RateLimiter {
    let l = this.#limiters.get(pluginId);
    if (!l) this.#limiters.set(pluginId, (l = new RateLimiter({ maxConcurrent: 2, requestsPerMinute: 30 })));
    return l;
  }
}
