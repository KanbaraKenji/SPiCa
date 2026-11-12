// Shared rate limiting (queue positions) and spending limits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostLedger, DEFAULT_PRICES } from './cost.ts';
import { RateLimiter } from './limiter.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway } from './testing/helpers.ts';

// gateways, child processes and local servers start slowly when several full runs share the machine
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('RateLimiter', () => {
  it('caps concurrency and reports queue positions', async () => {
    const lim = new RateLimiter({ maxConcurrent: 1 });
    const a = await lim.acquire();
    const positions: Record<string, number[]> = { b: [], c: [] };
    const pb = lim.acquire({ onPosition: (p) => positions.b!.push(p) });
    const pc = lim.acquire({ onPosition: (p) => positions.c!.push(p) });
    expect(lim.waiting).toBe(2);
    a.release();
    const b = await pb;
    expect(positions.c).toEqual([2, 1]);
    b.release();
    (await pc).release();
    expect(positions.b).toEqual([1]);
    expect(lim.active).toBe(0);
  });

  it('enforces requests per minute with a sliding window', async () => {
    vi.useFakeTimers();
    try {
      const lim = new RateLimiter({ requestsPerMinute: 2 });
      (await lim.acquire()).release();
      (await lim.acquire()).release();
      let third = false;
      const p = lim.acquire().then((l) => {
        third = true;
        l.release();
      });
      await vi.advanceTimersByTimeAsync(59_000);
      expect(third).toBe(false);
      await vi.advanceTimersByTimeAsync(1_100); // the oldest start leaves the 60 s window
      await p;
      expect(third).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a waiter can be cancelled without blocking the queue', async () => {
    const lim = new RateLimiter({ maxConcurrent: 1 });
    const a = await lim.acquire();
    const ac = new AbortController();
    const cancelled = lim.acquire({ signal: ac.signal });
    const next = lim.acquire();
    ac.abort();
    await expect(cancelled).rejects.toThrow();
    a.release();
    (await next).release();
  });
});

describe('limits in the runtime', () => {
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = await startGateway();
  });
  afterEach(async () => {
    await gw.stop();
  });

  it('parallel sessions share one limiter per provider and see their queue position', async () => {
    gw.onRequest(() => ({ text: 'ok', delayMs: 40 }));
    const rt = makeRuntime(gw, { limits: { 'fake-openai': { maxConcurrent: 1 } } });
    const events = captureEvents(rt);
    const sessions = [rt.createSession(), rt.createSession(), rt.createSession()];
    await Promise.all(sessions.map((s, i) => s.send(`job ${i}`).done));
    expect(gw.maxInFlight).toBe(1);
    const queued = events.filter((e) => e.type === 'queue');
    expect(queued.length).toBeGreaterThanOrEqual(2);
    expect(queued.some((e) => e.type === 'queue' && e.position === 2)).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.status === 'queued')).toBe(true);
  });

  it('stops a run once what it spent reaches the per-run limit, and says why', async () => {
    gw.onRequest(() => ({ toolCalls: [{ name: 'list_dir', args: {} }], usage: { input: 100_000, output: 1_000 } }));
    const rt = makeRuntime(gw, {
      // unknown model → fallback price $5 / $20 per MTok (unverified)
      budget: { perRunUsd: 1.2 },
    });
    const events = captureEvents(rt);
    const s = rt.createSession({ maxTokens: 1000 });
    const r = await s.send('loop').done;
    expect(r.reason).toBe('budget');
    expect(r.detail).toMatch(/spending limit all:run reached/);
    // Each call costs 0.52 USD. At 0 and 0.52 and 1.04 spent (under 1.2) the call is made, whatever it might
    // cost; at 1.56 the limit is reached and the next one is not: only what is spent counts, so the run may pass
    // the limit by one step.
    expect(gw.requests).toHaveLength(3);
    expect(events.some((e) => e.type === 'budget.stop')).toBe(true);
    expect(s.status).toBe('idle');
  });

  it('a total limit for one provider: counted over runs and conversations, the call that could pass it is not made', async () => {
    gw.onRequest(() => ({ text: 'ok', usage: { input: 100_000, output: 1_000 } }));
    const rt = makeRuntime(gw, { budget: { perProvider: { 'fake-openai': { globalUsd: 1 } } } });
    const events = captureEvents(rt);
    // each call costs 0.52 USD at the fallback price: after two (1.04, past the limit) the third is not made
    expect((await rt.createSession({ maxTokens: 1000 }).send('a').done).reason).not.toBe('budget');
    expect((await rt.createSession({ maxTokens: 1000 }).send('b').done).reason).not.toBe('budget');
    expect((await rt.createSession({ maxTokens: 1000 }).send('c').done).reason).toBe('budget');
    expect(events.find((e) => e.type === 'budget.stop')).toMatchObject({ scope: 'fake-openai:global', limitUsd: 1 });
    expect(rt.ledger.providerUsd('fake-openai')).toBeCloseTo(1.04);
  });

  it('refuses a single call whose worst case exceeds the per-call limit of its provider', async () => {
    const rt = makeRuntime(gw, { budget: { perProvider: { 'fake-openai': { perCallUsd: 0.01 } } } });
    const s = rt.createSession({ maxTokens: 100_000 }); // up to $2 of output
    const r = await s.send('hi').done;
    expect(r.reason).toBe('budget');
    expect(r.detail).toMatch(/per-call limit/);
    expect(gw.requests).toHaveLength(0);
  });

  it('the stop says what was spent and the limit: spent has reached it', async () => {
    gw.onRequest(() => ({ toolCalls: [{ name: 'list_dir', args: {} }], usage: { input: 100_000, output: 1_000 } }));
    const rt = makeRuntime(gw, { budget: { perRunUsd: 1.2 } });
    const events = captureEvents(rt);
    await rt.createSession({ maxTokens: 1000 }).send('loop').done;
    const stop = events.find((e) => e.type === 'budget.stop');
    expect(stop).toMatchObject({ limitUsd: 1.2 });
    if (stop?.type !== 'budget.stop') throw new Error('no stop');
    expect(stop.spentUsd).toBeGreaterThanOrEqual(1.2);
    expect(stop.message).toMatch(/spent \$1\.5600 of \$1\.20/);
  });

  it('a limit above what is spent never stops a call however much it might cost (0.10 with 0.05 spent)', () => {
    const l = new CostLedger({ 'openai-compatible': { m: { input: 2, output: 8 } } }, { perProvider: { p: { globalUsd: 0.1 } } });
    const scope = { providerId: 'p', providerKind: 'openai-compatible', model: 'm', sessionId: 's', runId: 'r' };
    l.seed([{ providerId: 'p', costUsd: 0.05 }]);
    // the worst case of this call (384,000 tokens of output) is far over the limit: it is not counted in
    expect(l.reserve(scope, 50_000, 384_000)).toMatchObject({ ok: true });
    l.record(scope, { inputTokens: 10_000, outputTokens: 1_000 }); // 0.028 -> 0.078 spent
    expect(l.precheck(scope, 50_000, 384_000)).toEqual({ ok: true });
    l.record(scope, { inputTokens: 10_000, outputTokens: 1_000 }); // 0.106: reached
    expect(l.precheck(scope, 1, 1)).toMatchObject({ ok: false, scope: 'p:global', limitUsd: 0.1 });
    // and nothing waits for calls still running
    expect(l.reserve(scope, 1, 1)).toMatchObject({ ok: false, wait: false });
  });

  it('no limit set: nothing stops the run', async () => {
    let n = 0;
    gw.onRequest(() => (++n < 4 ? { toolCalls: [{ name: 'list_dir', args: {} }], usage: { input: 100_000, output: 1_000 } } : { text: 'done' }));
    const rt = makeRuntime(gw);
    const r = await rt.createSession({ maxTokens: 1000 }).send('loop').done;
    expect(r.reason).not.toBe('budget');
    expect(rt.ledger.globalUsd).toBeGreaterThan(1.5);
  });

  it('a model without a price: not counted, never stopped by a limit, marked 未计价 in events, records and totals', async () => {
    let n = 0;
    gw.onRequest(() => (++n < 3 ? { toolCalls: [{ name: 'list_dir', args: {} }], usage: { input: 100_000, output: 1_000 } } : { text: 'done' }));
    const rt = makeRuntime(gw, { prices: DEFAULT_PRICES, budget: { perRunUsd: 0.01, perCallUsd: 0.01, globalUsd: 0.01 } });
    const events = captureEvents(rt);
    const s = rt.createSession({ maxTokens: 1000 });
    const r = await s.send('loop').done;
    expect(r.reason).not.toBe('budget');
    expect(gw.requests).toHaveLength(3);
    expect(events.some((e) => e.type === 'budget.stop')).toBe(false);
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage.length).toBe(3);
    expect(usage.every((e) => e.type === 'usage' && e.unpriced === true && e.costUsd === 0)).toBe(true);
    expect(events.find((e) => e.type === 'cost' && e.scope === 'session')).toMatchObject({ spentUsd: 0, unpriced: true });
    expect(s.info()).toMatchObject({ costUsd: 0, unpriced: true });
    expect(rt.ledger.hasUnpriced()).toBe(true);
    const traces = rt.store.listTraces({ sessionId: s.id }).filter((t) => t.kind === 'model');
    expect(traces.every((t) => t.unpriced === true && t.costUsd === undefined)).toBe(true);
  });

  it('after a restart: older records of a model without a price (written at the stand-in price) count nothing, and the usage log says 未计价', async () => {
    const rt = makeRuntime(gw, { prices: DEFAULT_PRICES });
    const old = { kind: 'model' as const, startedAt: new Date().toISOString(), durationMs: 1, sessionId: null, parentChain: [], initiator: 'model', target: 'x', status: 'ok' as const };
    rt.store.appendTrace({ ...old, id: 'tr-old', providerId: 'fake-openai', model: 'fake-model', costUsd: 0.75 });
    rt.store.appendTrace({ ...old, id: 'tr-gone', providerId: 'removed-provider', model: 'fake-model', costUsd: 0.25 });
    rt.restore();
    expect(rt.ledger.hasUnpriced()).toBe(true);
    // a provider no longer set up cannot be told: its record stays as it was written
    expect(rt.ledger.globalUsd).toBeCloseTo(0.25);
    const lines = rt.exportUsageLog().split(/\n/).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.find((l) => l.id === 'tr-old')).toMatchObject({ type: 'trace', unpriced: true });
    expect(lines.find((l) => l.id === 'tr-old')!.costUsd).toBeUndefined();
    expect(lines.find((l) => l.id === 'tr-gone')).toMatchObject({ costUsd: 0.25 });
  });

  it('warns when a total passes the warning threshold', async () => {
    gw.onRequest(() => ({ text: 'ok', usage: { input: 10_000, output: 0 } }));
    const rt = makeRuntime(gw, { budget: { globalUsd: 0.06, warnAt: 0.5 } });
    const events = captureEvents(rt);
    const s = rt.createSession({ maxTokens: 10 });
    await s.send('a').done; // 0.05 of 0.06
    const warn = events.find((e) => e.type === 'cost' && e.scope === 'global');
    expect(warn).toMatchObject({ warning: true, limitUsd: 0.06 });
  });
});

describe('CostLedger', () => {
  it('prices cached input separately for both usage conventions', () => {
    const ledger = new CostLedger({
      anthropic: { m: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } },
      'openai-compatible': { m: { input: 1, output: 2, cacheRead: 0.1 } },
    });
    // Anthropic: input_tokens excludes cached tokens
    expect(ledger.estimate({ providerId: 'x', providerKind: 'anthropic', model: 'm' }, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(1.1);
    // OpenAI style: prompt_tokens includes cached tokens
    expect(ledger.estimate({ providerId: 'x', providerKind: 'openai-compatible', model: 'm' }, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 400_000 })).toBeCloseTo(0.64);
  });
});

describe('models without a price (未计价)', () => {
  const priced = { providerId: 'p', providerKind: 'openai-compatible', model: 'known', sessionId: 's1', runId: 'r1' };
  const unpriced = { ...priced, model: 'mystery' };
  const ledger = () => new CostLedger({ 'openai-compatible': { known: { input: 1, output: 1 }, '*': { input: 5, output: 20, unverified: true, unpriced: true } } }, { perRunUsd: 0.5 });

  it('a stand-in row is not a price; a price not checked yet (unverified only) is one', () => {
    const l = new CostLedger({ x: { checked: { input: 1, output: 1 }, unchecked: { input: 1, output: 1, unverified: true } } });
    expect(l.priced({ providerId: 'x', providerKind: 'k', model: 'checked' })).toBe(true);
    expect(l.priced({ providerId: 'x', providerKind: 'k', model: 'unchecked' })).toBe(true);
    expect(l.priced({ providerId: 'x', providerKind: 'k', model: 'nothing' })).toBe(false); // FALLBACK_PRICE
    expect(new CostLedger().priced({ providerId: 'x', providerKind: 'openai-compatible', model: 'nobody-knows-this' })).toBe(false);
  });

  it('counts nothing and is never stopped; priced calls in the same run and session still are', () => {
    const l = ledger();
    const hold = l.reserve(unpriced, 1_000_000, 1_000_000);
    expect(hold).toMatchObject({ ok: true, usd: 0 });
    const rec = l.record(unpriced, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(rec).toMatchObject({ costUsd: 0, unpriced: true });
    expect(rec.totals.find((t) => t.scope === 'run')).toMatchObject({ spentUsd: 0, unpriced: true });
    expect(l.precheck(unpriced, 1_000_000, 1_000_000)).toEqual({ ok: true });
    // mixed: the priced part has a number, the totals say calls without a price are left out
    const rec2 = l.record(priced, { inputTokens: 200_000, outputTokens: 0 });
    expect(rec2.unpriced).toBeUndefined();
    expect(rec2.totals.find((t) => t.scope === 'session')).toMatchObject({ spentUsd: 0.2, unpriced: true });
    // 0.2 of a 0.5 per-run limit spent: the next priced call goes, whatever it might cost
    expect(l.precheck(priced, 200_000, 200_000)).toEqual({ ok: true });
    l.record(priced, { inputTokens: 300_000, outputTokens: 0 });
    expect(l.precheck(priced, 1, 1)).toMatchObject({ ok: false, scope: 'all:run', spentUsd: 0.5 });
  });

  it('an older record of such a model, written at the stand-in price, is marked and not added again', () => {
    const l = ledger();
    l.seed([
      { providerId: 'p', sessionId: 's1', costUsd: 0.75, unpriced: true },
      { providerId: 'p', sessionId: 's2', costUsd: 0.1 },
    ]);
    expect(l.globalUsd).toBeCloseTo(0.1);
    expect(l.sessionUsd('s1')).toBe(0);
    expect(l.hasUnpriced('s1')).toBe(true);
    expect(l.hasUnpriced('s2')).toBe(false);
    expect(l.hasUnpriced()).toBe(true);
  });
});

describe('price lookup', () => {
  it('never prices an unknown provider or model at zero', () => {
    const custom = new CostLedger({ mine: { 'known-model': { input: 1, output: 1 } } });
    expect(custom.price('mine', 'openai-compatible', 'known-model')).toEqual({ input: 1, output: 1 });
    expect(custom.price('other', 'wso2', 'mystery')).toMatchObject({ input: 10, output: 50, unverified: true });
    const defaults = new CostLedger();
    // exact model under the kind wins over a '*' row under the id
    expect(defaults.price('anthropic-prod', 'anthropic', 'claude-haiku-5-5')).toMatchObject({ input: 0.1 });
  });
});
