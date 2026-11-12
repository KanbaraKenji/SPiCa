// The request log: one record per HTTP attempt to a model, kept across restarts and capped;
// 429 answers stay visible after a retry that succeeded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, tempDir } from './testing/helpers.ts';
import { SqliteStore } from './store/sqlite.ts';
import { MemoryStore } from './store/memory.ts';
import { Tracer, REQUEST_LOG_MAX } from './trace.ts';
import { postWithRetry } from './providers/http.ts';
import type { AttemptReport, CallInfo } from './providers/types.ts';
import type { RequestRecord } from './types.ts';
import { bucketStart, summarizeRequests } from './usage.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const FAST = { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2 };

function scripted(...replies: (number | Error)[]): typeof fetch {
  let i = 0;
  return (async () => {
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return new Response(r === 200 ? 'data: {}\n\n' : `{"error":"status ${r}"}`, { status: r, headers: { 'content-type': 'application/json', ...(r === 429 ? { 'retry-after': '0' } : {}) } });
  }) as typeof fetch;
}

async function post(fetchImpl: typeof fetch, info: CallInfo, extra: Partial<Parameters<typeof postWithRetry>[0]> = {}) {
  return postWithRetry({ url: 'http://example.com/v1/chat', body: '{}', headers: {}, signal: new AbortController().signal, timeoutMs: 5000, retry: FAST, info, fetchImpl, ...extra });
}

describe('postWithRetry reports every attempt', () => {
  it('a 429 retried and then answered is one failed attempt, and the answering one is left for the caller', async () => {
    const seen: AttemptReport[] = [];
    const info: CallInfo = { attempts: 0, onAttempt: (a) => seen.push(a) };
    const res = await post(scripted(429, 429, 200), info);
    expect(res.status).toBe(200);
    expect(seen.map((a) => [a.attempt, a.httpStatus, a.code, a.retried])).toEqual([
      [1, 429, 'gateway.rate_limited', true],
      [2, 429, 'gateway.rate_limited', true],
    ]);
    expect(info.answering?.attempt).toBe(3);
    expect(info.httpStatus).toBe(200);
  });

  it('the last failed attempt says nothing followed it', async () => {
    const seen: AttemptReport[] = [];
    await expect(post(scripted(503), { attempts: 0, onAttempt: (a) => seen.push(a) })).rejects.toThrow(/HTTP 503/);
    expect(seen.map((a) => a.retried)).toEqual([true, true, true, false]);
    expect(seen.every((a) => a.code === 'gateway.server')).toBe(true);
  });

  it('a credential refresh retry is its own attempt number', async () => {
    const seen: AttemptReport[] = [];
    const auth = { headers: async () => ({}), refresh: async () => true };
    await post(scripted(401, 200), { attempts: 0, onAttempt: (a) => seen.push(a) }, { auth });
    expect(seen.map((a) => [a.attempt, a.httpStatus, a.retried])).toEqual([[1, 401, true]]);
  });

  it('network errors carry their code', async () => {
    const seen: AttemptReport[] = [];
    const err = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    await expect(post(scripted(err), { attempts: 0, onAttempt: (a) => seen.push(a) })).rejects.toThrow(/net\.refused/);
    expect(seen).toHaveLength(4);
    expect(seen[0]).toMatchObject({ status: 'error', code: 'net.refused', retried: true });
    expect(seen[0]!.httpStatus).toBeUndefined();
  });

  it('stopped before the answer came: an aborted attempt', async () => {
    const seen: AttemptReport[] = [];
    const ctl = new AbortController();
    const hang = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const p = post(hang, { attempts: 0, onAttempt: (a) => seen.push(a) }, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await expect(p).rejects.toThrow();
    expect(seen.map((a) => a.status)).toEqual(['aborted']);
  });
});

describe('Tracer request records', () => {
  it('writes the failed attempts at once and the answering one with its tokens at finish', () => {
    const store = new MemoryStore();
    const tracer = new Tracer(store);
    const h = tracer.start({ kind: 'model', sessionId: 's1', parentChain: [], initiator: 'model', target: 'x', providerId: 'p', model: 'm' });
    const info = h.watch({ attempts: 0 });
    info.onAttempt!({ attempt: 1, startedAt: '2026-11-13T01:00:00.000Z', durationMs: 12, status: 'error', httpStatus: 429, code: 'gateway.rate_limited', error: 'HTTP 429 key sk-abcdefghijklmnop', retried: true });
    expect(store.listRequests()).toHaveLength(1);
    info.answering = { attempt: 2, startedAt: '2026-11-13T01:00:01.000Z', t0: performance.now() };
    info.httpStatus = 200;
    h.finish({ status: 'ok', attempts: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, costUsd: 0.01, model: 'm-2026' });
    const recs = store.listRequests();
    expect(recs.map((r) => [r.attempt, r.httpStatus, r.status, r.retried ?? false])).toEqual([
      [1, 429, 'error', true],
      [2, 200, 'ok', false],
    ]);
    expect(recs[0]!.error).not.toContain('sk-abcdefghijklmnop');
    expect(recs[1]).toMatchObject({ traceId: h.id, sessionId: 's1', initiator: 'model', providerId: 'p', model: 'm-2026', inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, costUsd: 0.01 });
  });

  it('a call that failed in the middle of the answer keeps the status and the code', () => {
    const store = new MemoryStore();
    const h = new Tracer(store).start({ kind: 'model', sessionId: null, parentChain: [], initiator: 'runtime:memory-tidy', target: 'x', providerId: 'p', model: 'm' });
    const info = h.watch({ attempts: 0 });
    info.answering = { attempt: 1, startedAt: new Date().toISOString(), t0: performance.now() };
    info.httpStatus = 200;
    h.finish({ status: 'error', attempts: 1, error: 'stream idle', errorCode: 'gateway.stream_idle' });
    expect(store.listRequests()).toEqual([expect.objectContaining({ status: 'error', httpStatus: 200, errorCode: 'gateway.stream_idle', sessionId: null })]);
  });
});

describe('a conversation through the fake gateway', () => {
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = await startGateway({ apiKey: 'test-key-123456' });
  });
  afterEach(async () => {
    await gw.stop();
  });

  it('keeps the 429 after the retry answered, and sends each record as an event', async () => {
    gw.enqueue({ status: 429, headers: { 'retry-after': '0' } }, { text: 'ok', usage: { input: 30, output: 5 } });
    const rt = makeRuntime(gw);
    const events = captureEvents(rt);
    const s = rt.createSession({});
    await s.send('hi').done;
    const recs = rt.store.listRequests();
    expect(recs.map((r) => [r.attempt, r.httpStatus, r.status])).toEqual([
      [1, 429, 'error'],
      [2, 200, 'ok'],
    ]);
    expect(recs[1]).toMatchObject({ sessionId: s.id, inputTokens: 30, outputTokens: 5, providerId: 'fake-openai' });
    expect(events.filter((e) => e.type === 'request').map((e) => (e.type === 'request' ? e.record.attempt : 0))).toEqual([1, 2]);
    // the call itself is still one trace
    expect(rt.store.listTraces().filter((t) => t.kind === 'model')).toHaveLength(1);
  });
});

describe('SqliteStore request log', () => {
  const rec = (i: number, at: string, over: Partial<RequestRecord> = {}): RequestRecord => ({ id: `rq${i}`, traceId: `tr${i}`, startedAt: at, durationMs: 10, sessionId: null, initiator: 'model', attempt: 1, status: 'ok', ...over });

  const closers: (() => void)[] = [];
  const onFinally = (f: () => void) => closers.push(f);

  it('is kept across a restart, listed by time (any offset), capped from the oldest', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = join(dir, 'spica.db');
      let db = new SqliteStore(file);
      onFinally(() => db.close());
      db.appendRequest(rec(1, '2026-11-13T09:00:00.000+08:00')); // 01:00 UTC
      db.appendRequest(rec(2, '2026-11-13T00:30:00.000Z'));
      db.appendRequest(rec(3, '2026-11-13T02:00:00.000Z', { httpStatus: 429 }));
      db.close();
      db = new SqliteStore(file);
      expect(db.listRequests().map((r) => r.id)).toEqual(['rq2', 'rq1', 'rq3']);
      expect(db.firstRequestAt()).toBe('2026-11-13T00:30:00.000Z');
      expect(db.listRequests({ fromMs: Date.parse('2026-11-13T00:45:00Z'), toMs: Date.parse('2026-11-13T01:30:00Z') }).map((r) => r.id)).toEqual(['rq1']);
      expect(db.listRequests({ limit: 2, newest: true }).map((r) => r.id)).toEqual(['rq1', 'rq3']);
      db.pruneRequests(2);
      expect(db.listRequests().map((r) => r.id)).toEqual(['rq1', 'rq3']);
      db.pruneRequests(5);
      expect(db.listRequests()).toHaveLength(2);
    } finally {
      for (const f of closers.splice(0)) f();
      await cleanup();
    }
  });

  it('the tracer drops the oldest beyond the cap when it starts', () => {
    const store = new MemoryStore();
    for (let i = 0; i < REQUEST_LOG_MAX + 3; i++) store.appendRequest(rec(i, new Date(1_700_000_000_000 + i).toISOString()));
    new Tracer(store);
    expect(store.listRequests()).toHaveLength(REQUEST_LOG_MAX);
    expect(store.listRequests({ limit: 1 })[0]!.id).toBe('rq3');
  });
});

describe('summarizeRequests', () => {
  const r = (at: string, over: Partial<RequestRecord> = {}): RequestRecord => ({ id: at, traceId: 't', startedAt: at, durationMs: 1, sessionId: null, initiator: 'model', providerId: 'deepseek', model: 'deepseek-chat', attempt: 1, status: 'ok', ...over });

  it('days start at the given offset, not at the machine’s', () => {
    // 23:30 UTC on the 12th is the 13th in UTC+8
    expect(new Date(bucketStart(Date.parse('2026-11-12T23:30:00Z'), 'day', 480)).toISOString()).toBe('2026-11-12T16:00:00.000Z');
    expect(new Date(bucketStart(Date.parse('2026-11-12T23:30:00Z'), 'day', 0)).toISOString()).toBe('2026-11-12T00:00:00.000Z');
    expect(new Date(bucketStart(Date.parse('2026-11-12T23:30:00Z'), 'hour')).toISOString()).toBe('2026-11-12T23:00:00.000Z');
  });

  it('sums per bucket and model, counts 429 apart, leaves unpriced cost out', () => {
    const s = summarizeRequests(
      [
        r('2026-11-13T01:00:00Z', { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, costUsd: 0.5 }),
        r('2026-11-13T02:00:00Z', { status: 'error', httpStatus: 429, errorCode: 'gateway.rate_limited', retried: true }),
        r('2026-11-13T02:00:01Z', { status: 'error', httpStatus: 503, errorCode: 'wso2.throttled' }),
        r('2026-11-13T03:00:00Z', { model: 'other', unpriced: true, inputTokens: 7 }),
        r('2026-11-15T03:00:00Z'), // outside
      ],
      { from: '2026-11-13T00:00:00Z', to: '2026-11-14T00:00:00Z', bucket: 'day', tzOffsetMinutes: 0 },
      '2026-11-01T00:00:00Z',
    );
    expect(s.since).toBe('2026-11-01T00:00:00Z');
    expect(s.rows).toEqual([
      expect.objectContaining({ bucket: '2026-11-13T00:00:00.000Z', model: 'deepseek-chat', requests: 3, ok: 1, failed: 1, rateLimited: 1, inputTokens: 100, cacheReadTokens: 50, costUsd: 0.5 }),
      expect.objectContaining({ model: 'other', requests: 1, unpriced: true, costUsd: 0, inputTokens: 7 }),
    ]);
    // a gateway's 503 throttle is not a 429
    expect(s.rateLimited.map((x) => x.httpStatus)).toEqual([429]);
  });
});
