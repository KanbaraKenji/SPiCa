// Many sub-agents at once: the shared limiter queues them in order, every
// queued agent sees its position, and spending limits hold for the sum of
// calls running in parallel (not only for each call on its own).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, until } from './testing/helpers.ts';
import type { CoreEvent } from './types.ts';

// gateways, child processes and local servers start slowly when several full runs share the machine
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
beforeEach(async () => {
  gw = await startGateway();
});
afterEach(async () => {
  await gw.stop();
});

const jobOf = (body: Record<string, unknown>) => {
  const msgs = body.messages as { role: string; content: unknown }[];
  const last = JSON.stringify(msgs.filter((m) => m.role === 'user').at(-1)?.content ?? '');
  return Number(/job (\d+)/.exec(last)?.[1] ?? -1);
};
const positionsBy = (events: CoreEvent[], id: string) => events.flatMap((e) => (e.type === 'queue' && e.sessionId === id ? [e.position] : []));

describe('16 sub-agents at once', () => {
  it('the limiter caps calls in flight, serves in order and reports every position change', async () => {
    gw.onRequest(() => ({ text: 'ok', delayMs: 25, usage: { input: 500, output: 20 } }));
    const rt = makeRuntime(gw, { limits: { 'fake-openai': { maxConcurrent: 3 } } });
    const events = captureEvents(rt);
    const pm = rt.createSession({ role: 'manager' });
    const workers = Array.from({ length: 16 }, (_, i) => rt.createSession({ parentId: pm.id, title: `w${i}` }));
    const runs = workers.map((w, i) => w.send(`job ${i}`).done);
    // while they run, the queue is visible: 3 calls in flight, the rest waiting
    await until(() => rt.limiter('fake-openai').waiting === 13);
    expect(rt.limiter('fake-openai').active).toBe(3);
    expect(workers.filter((w) => w.status === 'queued')).toHaveLength(13);
    const results = await Promise.all(runs);

    expect(results.every((r) => r.reason === 'completed')).toBe(true);
    expect(gw.maxInFlight).toBe(3);
    // first come, first served
    expect(gw.requests.map((r) => jobOf(r.body))).toEqual(workers.map((_, i) => i));
    workers.forEach((w, i) => {
      const pos = positionsBy(events, w.id);
      if (i < 3) return expect(pos).toEqual([]); // a free slot: never queued
      // joined at its place in line, then moved up one step at a time
      expect(pos[0]).toBe(i - 2);
      expect(pos).toEqual(Array.from({ length: i - 2 }, (_, k) => i - 2 - k));
      // queued → thinking: the user sees the wait end
      const st = events.flatMap((e) => (e.type === 'status' && e.sessionId === w.id ? [e.status] : []));
      expect(st.indexOf('queued')).toBeLessThan(st.indexOf('thinking'));
      expect(w.status).toBe('done');
    });
    expect(rt.limiter('fake-openai').active).toBe(0);
    expect(rt.ledger.heldUsd).toBe(0);
  });

  for (const maxConcurrent of [0, 4]) {
    it(`a global spending limit holds for the sum of parallel calls (maxConcurrent ${maxConcurrent || 'unlimited'})`, async () => {
      // fake-model → fallback price $5 / $20 per MTok. Each call really costs
      // 1000·5e-6 + 100·2e-5 = $0.007; its worst case (maxTokens 512) is over $0.010.
      gw.onRequest(() => ({ text: 'ok', delayMs: 30, usage: { input: 1000, output: 100 } }));
      const limit = 0.05;
      const rt = makeRuntime(gw, {
        budget: { globalUsd: limit },
        ...(maxConcurrent ? { limits: { 'fake-openai': { maxConcurrent } } } : {}),
      });
      const events = captureEvents(rt);
      const pm = rt.createSession({ role: 'manager' });
      const workers = Array.from({ length: 16 }, () => rt.createSession({ parentId: pm.id }));
      const results = await Promise.all(workers.map((w, i) => w.send(`job ${i}`).done));

      const sent = gw.requests.length;
      expect(rt.ledger.globalUsd).toBeLessThanOrEqual(limit);
      expect(rt.ledger.globalUsd).toBeCloseTo(sent * 0.007, 6);
      // waiting for running calls to be recorded lets more through than worst cases alone would (2)
      expect(sent).toBeGreaterThanOrEqual(4);
      expect(sent).toBeLessThan(16);
      const stopped = results.filter((r) => r.reason === 'budget');
      expect(stopped).toHaveLength(16 - sent);
      expect(events.filter((e) => e.type === 'budget.stop')).toHaveLength(16 - sent);
      expect(rt.ledger.heldUsd).toBe(0);
      if (maxConcurrent) expect(gw.maxInFlight).toBeLessThanOrEqual(maxConcurrent);
    });
  }

  it('stopping a queued or a running sub-agent frees its place and its held budget', async () => {
    gw.onRequest((r) => ({ text: 'ok', delayMs: jobOf(r.body) === 0 ? 400 : 10, usage: { input: 100, output: 10 } }));
    const rt = makeRuntime(gw, { budget: { globalUsd: 10 }, limits: { 'fake-openai': { maxConcurrent: 1 } } });
    const events = captureEvents(rt);
    const pm = rt.createSession({ role: 'manager' });
    const [a, b, c] = [0, 1, 2].map(() => rt.createSession({ parentId: pm.id }));
    const ra = a!.send('job 0').done;
    await until(() => a!.status === 'thinking');
    const held = rt.ledger.heldUsd;
    expect(held).toBeGreaterThan(0); // A's worst case is held while it runs
    const rb = b!.send('job 1').done;
    const rc = c!.send('job 2').done;
    await until(() => positionsBy(events, c!.id).includes(2));

    b!.abort(); // stopped while waiting in line
    expect((await rb).reason).toBe('aborted');
    await until(() => positionsBy(events, c!.id).at(-1) === 1); // C moves up
    expect(rt.ledger.heldUsd).toBe(held); // B never held anything

    a!.abort(); // stopped while its call runs
    expect((await ra).reason).toBe('aborted');
    expect((await rc).reason).toBe('completed'); // C gets the slot
    expect(rt.ledger.heldUsd).toBe(0);
    expect(gw.requests.map((r) => jobOf(r.body))).toEqual([0, 2]);
    expect(rt.ledger.globalUsd).toBeCloseTo(100 * 5e-6 + 10 * 2e-5, 9); // only C was billed
  });
});
