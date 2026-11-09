// WSO2-style gateway: OAuth2 client credentials, token caching, 401 refresh.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { FAST_RETRY, makeRuntime, startGateway } from '../testing/helpers.ts';
import { Wso2Provider } from './wso2.ts';

let gw: FakeGateway;
beforeEach(async () => {
  gw = await startGateway({ oauth: { clientId: 'spica-app', clientSecret: 's3cret-value', tokenTtlMs: 3_600_000 } });
});
afterEach(async () => {
  await gw.stop();
});

function wso2(over: Partial<{ clientSecret: string; refreshSkewMs: number }> = {}) {
  return new Wso2Provider({
    id: 'gateway',
    baseUrl: `${gw.baseUrl}/v1`,
    retry: FAST_RETRY,
    oauth: { tokenUrl: `${gw.baseUrl}/oauth2/token`, clientId: 'spica-app', clientSecret: over.clientSecret ?? 's3cret-value', ...(over.refreshSkewMs !== undefined ? { refreshSkewMs: over.refreshSkewMs } : {}) },
  });
}

const rtFor = (p: Wso2Provider) => makeRuntime(gw, { providers: [p], defaults: { providerId: 'gateway', model: 'gw-model', maxTokens: 64 } });

describe('Wso2Provider', () => {
  it('gets a token first, sends it as Bearer, and reuses it', async () => {
    gw.onRequest(() => ({ text: 'ok' }));
    const rt = rtFor(wso2());
    const s = rt.createSession();
    await s.send('one').done;
    await s.send('two').done;
    expect(gw.tokenRequests).toHaveLength(1);
    expect(gw.tokenRequests[0]!.grantType).toBe('client_credentials');
    expect(String(gw.requests[0]!.headers.authorization)).toMatch(/^Bearer [0-9a-f-]{36}$/);
    expect(gw.requests[1]!.headers.authorization).toBe(gw.requests[0]!.headers.authorization);
    const auth = rt.store.listTraces().filter((t) => t.kind === 'auth');
    expect(auth).toHaveLength(1);
    expect(auth[0]).toMatchObject({ status: 'ok', initiator: 'runtime', target: 'gateway:token', httpStatus: 200 });
  });

  it('after the token expires (401), fetches a new one once and resends', async () => {
    gw.onRequest(() => ({ text: 'ok' }));
    const rt = rtFor(wso2());
    const s = rt.createSession();
    await s.send('one').done;
    gw.expireTokens();
    const r = await s.send('two').done;
    expect(r).toMatchObject({ reason: 'completed', text: 'ok' });
    expect(gw.tokenRequests).toHaveLength(2);
    expect(gw.requests[1]!.headers.authorization).not.toBe(gw.requests[0]!.headers.authorization);
    // The model trace counts only the successful attempt chain; the refresh is its own auth trace.
    expect(rt.store.listTraces().filter((t) => t.kind === 'auth')).toHaveLength(2);
  });

  it('refreshes ahead of expiry without waiting for a 401', async () => {
    await gw.stop();
    gw = await startGateway({ oauth: { clientId: 'spica-app', clientSecret: 's3cret-value', tokenTtlMs: 2_000 } });
    gw.onRequest(() => ({ text: 'ok' }));
    const rt = rtFor(wso2({ refreshSkewMs: 1_500 }));
    const s = rt.createSession();
    await s.send('one').done;
    await new Promise((r) => setTimeout(r, 600)); // now inside the refresh window
    await s.send('two').done;
    expect(gw.tokenRequests).toHaveLength(2);
  });

  it('wrong credentials: a clear error, no retry storm, no secret in the message', async () => {
    const rt = rtFor(wso2({ clientSecret: 'wrong-secret-123' }));
    const r = await rt.createSession().send('hi').done;
    expect(r.reason).toBe('error');
    expect(r.detail).toMatch(/token request rejected \(HTTP 401\)/);
    expect(r.detail).not.toContain('wrong-secret-123');
    expect(gw.tokenRequests.length).toBeLessThanOrEqual(2);
    expect(gw.requests).toHaveLength(0);
  });

  it('concurrent sessions share one token request', async () => {
    gw.onRequest(() => ({ text: 'ok', delayMs: 20 }));
    const rt = rtFor(wso2());
    await Promise.all([rt.createSession(), rt.createSession(), rt.createSession()].map((s) => s.send('go').done));
    expect(gw.tokenRequests).toHaveLength(1);
  });

  it('is priced like an OpenAI-compatible endpoint via the fallback, never as free', async () => {
    gw.onRequest(() => ({ text: 'ok', usage: { input: 1000, output: 100 } }));
    const rt = rtFor(wso2());
    const s = rt.createSession();
    await s.send('x').done;
    expect(rt.ledger.sessionUsd(s.id)).toBeGreaterThan(0);
  });
});
