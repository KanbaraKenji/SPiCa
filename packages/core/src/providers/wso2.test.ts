// WSO2-style gateway: OAuth2 client credentials, token caching, 401 refresh.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { FAST_RETRY, makeRuntime, startGateway } from '../testing/helpers.ts';
import { OAuthClientCredentials, Wso2Provider } from './wso2.ts';

// gateways, child processes and local servers start slowly when several full runs share the machine
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

  it('a gateway model without a price is 未计价: no made-up cost, no limit stops it, and it is marked', async () => {
    gw.onRequest(() => ({ text: 'ok', usage: { input: 1000, output: 100 } }));
    const rt = makeRuntime(gw, { providers: [wso2()], defaults: { providerId: 'gateway', model: 'gw-model', maxTokens: 64 }, budget: { perRunUsd: 0.000001, perCallUsd: 0.000001 } });
    const s = rt.createSession();
    const r = await s.send('x').done;
    expect(r.reason).not.toBe('budget');
    expect(rt.ledger.sessionUsd(s.id)).toBe(0);
    expect(s.info()).toMatchObject({ costUsd: 0, unpriced: true });
    const trace = rt.store.listTraces({ sessionId: s.id }).find((t) => t.kind === 'model')!;
    expect(trace).toMatchObject({ unpriced: true });
    expect(trace.costUsd).toBeUndefined();
  });
});

describe('where the token endpoint wants the client credentials', () => {
  /** A token endpoint that takes the credentials only one way; records how each request carried them. */
  const endpoint = (takes: 'basic' | 'body' | 'none') => {
    const seen: ('basic' | 'body')[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const form = new URLSearchParams(String(init.body));
      const how = headers.authorization?.startsWith('Basic ') ? 'basic' : 'body';
      seen.push(how);
      const ok = takes === how && (how === 'body' ? form.get('client_id') === 'id-1' && form.get('client_secret') === 's-1' : true);
      return ok
        ? new Response(JSON.stringify({ access_token: `t-${seen.length}`, expires_in: 0.001 }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('{"error":"invalid_client"}', { status: 401, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  };
  const auth = (fetchImpl: typeof fetch, credentialsIn?: 'basic' | 'body') =>
    new OAuthClientCredentials({ tokenUrl: 'https://login.example.com/token', clientId: 'id-1', clientSecret: 's-1', fetchImpl, refreshSkewMs: 0, ...(credentialsIn ? { credentialsIn } : {}) });
  const signal = () => new AbortController().signal;

  it('not configured: Basic first, the form body once when Basic is refused, and that way from then on', async () => {
    const e = endpoint('body');
    const a = auth(e.fetchImpl);
    expect(await a.headers(signal())).toEqual({ authorization: 'Bearer t-2' });
    expect(e.seen).toEqual(['basic', 'body']);
    await new Promise((r) => setTimeout(r, 5)); // the token ran out
    await a.headers(signal());
    expect(e.seen).toEqual(['basic', 'body', 'body']); // remembered: no Basic try again
  });

  it('a gateway that takes Basic is asked once; a configured way is the only one tried; refused both ways is token_rejected', async () => {
    const basic = endpoint('basic');
    await auth(basic.fetchImpl).headers(signal());
    expect(basic.seen).toEqual(['basic']);
    const onlyBasic = endpoint('body');
    await expect(auth(onlyBasic.fetchImpl, 'basic').headers(signal())).rejects.toMatchObject({ code: 'wso2.token_rejected' });
    expect(onlyBasic.seen).toEqual(['basic']);
    const none = endpoint('none');
    await expect(auth(none.fetchImpl).headers(signal())).rejects.toMatchObject({ code: 'wso2.token_rejected' });
    expect(none.seen).toEqual(['basic', 'body']);
  });
});
