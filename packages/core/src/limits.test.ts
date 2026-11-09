// Shared rate limiting (queue positions) and spending limits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostLedger } from './cost.ts';
import { RateLimiter } from './limiter.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway } from './testing/helpers.ts';

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

  it('stops a run before a call that could cross the per-run limit, and says why', async () => {
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
    // Each call costs 0.52 USD. After two (1.04), the next call's input is at least the last
    // call's 100k tokens, so its worst case (0.52) would cross 1.2: it is not sent.
    expect(gw.requests).toHaveLength(2);
    expect(events.some((e) => e.type === 'budget.stop')).toBe(true);
    expect(s.status).toBe('idle');
  });

  it('refuses a single call whose worst case exceeds the per-call limit of its provider', async () => {
    const rt = makeRuntime(gw, { budget: { perProvider: { 'fake-openai': { perCallUsd: 0.01 } } } });
    const s = rt.createSession({ maxTokens: 100_000 }); // up to $2 of output
    const r = await s.send('hi').done;
    expect(r.reason).toBe('budget');
    expect(r.detail).toMatch(/per-call limit/);
    expect(gw.requests).toHaveLength(0);
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
