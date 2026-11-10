import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../store/memory.ts';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { anthropicProvider, openaiProvider, startGateway } from '../testing/helpers.ts';
import { Tracer } from '../trace.ts';
import { OpenAICompatibleProvider } from './openai.ts';
import { probeProvider } from './probe.ts';
import { Wso2Provider } from './wso2.ts';

// gateways, child processes and local servers start slowly when several full runs share the machine
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
beforeEach(async () => {
  gw = await startGateway({ apiKey: 'test-key-123456' });
});
afterEach(async () => {
  await gw.stop();
});

describe('probeProvider', () => {
  it('reports success, latency and the model the server named, with a trace outside any session', async () => {
    gw.enqueue({ text: 'pong' });
    const store = new MemoryStore();
    const r = await probeProvider(openaiProvider(gw), { model: 'my-model', tracer: new Tracer(store) });
    expect(r).toMatchObject({ ok: true, model: 'my-model' });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(gw.requests[0]!.body.max_tokens).toBe(16);
    expect(store.listTraces()[0]).toMatchObject({ initiator: 'runtime:probe', sessionId: null, status: 'ok' });
  });

  it('works for the Anthropic provider too', async () => {
    gw.enqueue({ text: 'pong' });
    expect((await probeProvider(anthropicProvider(gw), { model: 'claude-x' })).ok).toBe(true);
  });

  it('classifies failures without making up user-facing text', async () => {
    const bad = new OpenAICompatibleProvider({ id: 'x', baseUrl: `${gw.baseUrl}/v1`, apiKey: 'wrong-key-999999', retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    const auth = await probeProvider(bad, { model: 'm' });
    expect(auth).toMatchObject({ ok: false, errorCode: 'auth', httpStatus: 401 });
    expect(auth.message).not.toContain('wrong-key-999999');

    gw.enqueue({ status: 404, errorBody: '{"error":"no such model"}' });
    expect(await probeProvider(openaiProvider(gw), { model: 'm' })).toMatchObject({ ok: false, errorCode: 'not_found' });

    const offline = new OpenAICompatibleProvider({ id: 'y', baseUrl: 'http://127.0.0.1:9/v1', retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    expect(await probeProvider(offline, { model: 'm' })).toMatchObject({ ok: false, errorCode: 'network' });

    gw.enqueue({ text: 'slow', delayMs: 2000 });
    expect(await probeProvider(openaiProvider(gw), { model: 'm', timeoutMs: 200 })).toMatchObject({ ok: false, errorCode: 'timeout' });
  });

  it('rejected WSO2 credentials count as an auth problem', async () => {
    await gw.stop();
    gw = await startGateway({ oauth: { clientId: 'id', clientSecret: 'right' } });
    const p = new Wso2Provider({ id: 'gw', baseUrl: `${gw.baseUrl}/v1`, oauth: { tokenUrl: `${gw.baseUrl}/oauth2/token`, clientId: 'id', clientSecret: 'wrong' } });
    expect(await probeProvider(p, { model: 'm' })).toMatchObject({ ok: false, errorCode: 'auth' });
  });
});
