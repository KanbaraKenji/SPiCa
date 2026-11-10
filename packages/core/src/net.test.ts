// Company network: a proxy (with exceptions and login), extra trusted CAs for
// TLS inspection, readable error codes, and WSO2 failures told apart.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttp, request as httpRequest, type Server } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from './mcp/client.ts';
import {
  configureNetwork,
  gatewayFaultCode,
  httpErrorCode,
  listenFetchable,
  NET_HINTS,
  netErrorCode,
  netFetch,
  networkChildEnv,
  networkSecrets,
  networkStatus,
  proxyFor,
  withNetworkEnv,
} from './net.ts';
import { probeProvider } from './providers/probe.ts';
import { Wso2Provider } from './providers/wso2.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { makeRuntime, openaiProvider, startGateway, tempDir } from './testing/helpers.ts';

let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;
const servers: Server[] = [];
const tunnels: import('node:stream').Duplex[] = [];
beforeEach(async () => {
  gw = await startGateway();
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  configureNetwork({ proxy: null, caFile: null, useSystemCa: false });
  for (const t of tunnels.splice(0)) t.destroy();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  await gw.stop();
  await cleanup();
});

const listen = async (s: Server) => {
  servers.push(s);
  return listenFetchable(s);
};

/** A forward proxy: plain HTTP by absolute URL, HTTPS by CONNECT; optionally wants a login. */
async function startProxy(opts: { user?: string; pass?: string } = {}) {
  const seen: string[] = [];
  const authOk = (h: string | undefined) => !opts.user || h === `Basic ${Buffer.from(`${opts.user}:${opts.pass}`).toString('base64')}`;
  const server = createHttp((req, res) => {
    seen.push(`GET ${req.url}`);
    if (!authOk(req.headers['proxy-authorization'])) return void res.writeHead(407).end();
    const target = new URL(req.url!);
    const { 'proxy-authorization': _a, ...headers } = req.headers;
    void _a;
    const up = httpRequest({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    req.pipe(up);
  });
  server.on('connect', (req, socket) => {
    seen.push(`CONNECT ${req.url}`);
    tunnels.push(socket);
    if (!authOk(req.headers['proxy-authorization'])) return void socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    const [host, port] = String(req.url).split(':');
    const up = netConnect(Number(port), host!, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(socket);
      socket.pipe(up);
    });
    tunnels.push(up);
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  const port = await listen(server);
  return { url: `http://${opts.user ? `${opts.user}:${opts.pass}@` : ''}127.0.0.1:${port}`, seen };
}

/** A throwaway CA and a server certificate for 127.0.0.1 / localhost (needs the openssl command). */
function makeCerts(at: string): { ca: string; cert: string; key: string } | undefined {
  try {
    const run = (...args: string[]) => execFileSync('openssl', args, { cwd: at, stdio: 'pipe', env: { ...process.env, OPENSSL_CONF: join(at, 'o.cnf') } });
    // The CA states that it is one. Without explicit extensions OpenSSL 1.1 writes a v1
    // certificate (a CA by convention) but OpenSSL 3 a v3 one without basicConstraints,
    // which Node refuses as an issuer (INVALID_PURPOSE, "unsuitable certificate purpose").
    const cnf = [
      '[req]',
      'distinguished_name=dn',
      '[dn]',
      '[ca_ext]',
      'basicConstraints=critical,CA:TRUE',
      'keyUsage=critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier=hash',
      '[ext]',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      'basicConstraints=CA:FALSE',
      '',
    ].join('\n');
    writeFileSync(join(at, 'o.cnf'), cnf);
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Spica Test CA', '-config', 'o.cnf', '-extensions', 'ca_ext');
    run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost', '-config', 'o.cnf');
    run('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '2', '-extfile', 'o.cnf', '-extensions', 'ext');
    return { ca: join(at, 'ca.pem'), cert: join(at, 'srv.pem'), key: join(at, 'srv.key') };
  } catch {
    return undefined;
  }
}
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe('proxy', () => {
  it('model calls go through the proxy, except what noProxy lists; settings change while running', async () => {
    const proxy = await startProxy();
    gw.onRequest(() => ({ text: 'via proxy' }));
    configureNetwork({ proxy: { url: proxy.url } });
    expect(networkStatus().proxy).toBe(proxy.url);
    const rt = makeRuntime(gw, { providers: [openaiProvider(gw)] });
    expect((await rt.createSession().send('hi').done).text).toBe('via proxy');
    expect(proxy.seen.filter((s) => s.includes('/v1/chat/completions'))).toHaveLength(1);

    configureNetwork({ proxy: { url: proxy.url, noProxy: ['127.0.0.1'] } });
    await rt.createSession().send('again').done;
    expect(proxy.seen.filter((s) => s.includes('/v1/chat/completions'))).toHaveLength(1); // went direct

    expect(proxyFor(new URL('https://api.example.com/x'))?.host).toBe(proxy.url.replace('http://', ''));
    configureNetwork({ proxy: { url: proxy.url, noProxy: ['.example.com', 'intranet:8080'] } });
    expect(proxyFor(new URL('https://api.example.com/x'))).toBeUndefined();
    expect(proxyFor(new URL('https://example.com/x'))).toBeUndefined();
    expect(proxyFor(new URL('http://intranet:8080/'))).toBeUndefined();
    expect(proxyFor(new URL('http://intranet:9090/'))).toBeDefined();
    expect(proxyFor(new URL('https://notexample.com/'))).toBeDefined();
    await rt.close();
  });

  it('falls back to HTTPS_PROXY / NO_PROXY from the environment, and null switches the proxy off', () => {
    configureNetwork({}, { HTTPS_PROXY: 'http://proxy.corp:3128', NO_PROXY: 'localhost,.corp' });
    expect(networkStatus()).toMatchObject({ proxy: 'http://proxy.corp:3128', noProxy: ['localhost', '.corp'] });
    expect(proxyFor(new URL('https://git.corp/x'))).toBeUndefined();
    configureNetwork({ proxy: null }, { HTTPS_PROXY: 'http://proxy.corp:3128' });
    expect(networkStatus().proxy).toBeNull();
    configureNetwork({ proxy: { url: 'http://user:secret@proxy.corp:3128' } });
    expect(JSON.stringify(networkStatus())).not.toContain('secret');
  });

  it('a proxy that wants a login says so; with the login in the URL it works', async () => {
    const proxy = await startProxy({ user: 'ann', pass: 'p@ss' });
    configureNetwork({ proxy: { url: proxy.url.replace('ann:p@ss@', '') } });
    const err = await netFetch(`${gw.baseUrl}/health`).then(
      (r) => r.status,
      (e: unknown) => e,
    );
    expect(err).toBe(407); // plain HTTP: the proxy's answer comes back as is
    configureNetwork({ proxy: { url: proxy.url.replace('ann:p@ss@', 'ann:p%40ss@') } });
    expect(await (await netFetch(`${gw.baseUrl}/health`)).text()).toBe('ok');
  });
});

describe.skipIf(!hasOpenssl)('certificates', () => {
  it('a server signed by a company CA is trusted only with caFile, directly and through the proxy', async () => {
    await mkdir(join(dir, 'pki'));
    const certs = makeCerts(join(dir, 'pki'))!;
    expect(certs).toBeDefined();
    const https = createHttps({ cert: await readFile(certs.cert), key: await readFile(certs.key) }, (_req, res) => {
      res.writeHead(200, { connection: 'close', 'content-type': 'text/plain' }).end('secure hello');
    });
    const port = await listen(https as unknown as Server);
    const url = `https://localhost:${port}/`;
    configureNetwork({ proxy: null, useSystemCa: false });
    const fail = await netFetch(url).catch((e: unknown) => e);
    expect(netErrorCode(fail)).toBe('tls.untrusted');

    expect(configureNetwork({ proxy: null, caFile: certs.ca, useSystemCa: false }).warnings).toEqual([]);
    expect(await (await netFetch(url)).text()).toBe('secure hello');

    const proxy = await startProxy();
    configureNetwork({ proxy: { url: proxy.url }, caFile: certs.ca, useSystemCa: false });
    expect(await (await netFetch(url)).text()).toBe('secure hello');
    expect(proxy.seen).toContain(`CONNECT localhost:${port}`);

    // taken out again: the next request no longer trusts it
    configureNetwork({ proxy: { url: proxy.url }, caFile: null, useSystemCa: false });
    expect(netErrorCode(await netFetch(url).catch((e: unknown) => e))).toBe('tls.untrusted');
    // an unreadable CA file is a warning, not a crash
    expect(configureNetwork({ caFile: join(dir, 'missing.pem') }).warnings.join(' ')).toMatch(/CA file not read/);
    await writeFile(join(dir, 'empty.pem'), 'not a cert');
    expect(configureNetwork({ caFile: join(dir, 'empty.pem') }).warnings.join(' ')).toMatch(/no certificate found/);
  }, 30_000);
});

describe.skipIf(!hasOpenssl)('plugin servers connect like the app', () => {
  const certsIn = (pem: string) => pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;

  it('get the proxy, its exceptions and the trusted certificates when they start; the settings off remove inherited ones', async () => {
    await mkdir(join(dir, 'pki'));
    const certs = makeCerts(join(dir, 'pki'))!;
    const ca = (await readFile(certs.ca, 'utf8')).trim();
    configureNetwork({ proxy: { url: 'http://user:pa%40ss@proxy.example:8080', noProxy: ['corp.example'] }, caFile: certs.ca, useSystemCa: false });
    expect(networkSecrets()).toEqual(['pa@ss']);
    const env = networkChildEnv(join(dir, 'net'));
    for (const n of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) expect(env[n]).toBe('http://user:pa%40ss@proxy.example:8080/');
    expect(env.NO_PROXY!.split(',')).toEqual(expect.arrayContaining(['corp.example', 'localhost', '127.0.0.1']));
    expect(env.no_proxy).toBe(env.NO_PROXY);
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    // Node gets what is trusted beyond its own list; other programs the whole list
    const extra = await readFile(env.NODE_EXTRA_CA_CERTS!, 'utf8');
    expect(extra).toContain(ca);
    expect(certsIn(extra)).toBe(1);
    const bundle = await readFile(env.SSL_CERT_FILE!, 'utf8');
    expect(bundle).toContain(ca);
    expect(certsIn(bundle)).toBeGreaterThan(50);
    expect([env.REQUESTS_CA_BUNDLE, env.CURL_CA_BUNDLE]).toEqual([env.SSL_CERT_FILE, env.SSL_CERT_FILE]);
    expect(env.NODE_USE_SYSTEM_CA).toBeUndefined();

    // a real server process sees them; its own variables win
    const script = fileURLToPath(new URL('./testing/fake-mcp-server.mjs', import.meta.url));
    const c = new McpStdioClient({ name: 'fake', command: process.execPath, args: [script], env: { NO_PROXY: 'own.example' } });
    await c.connect();
    try {
      const seen = JSON.parse((await c.callTool('env', { names: ['HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'] })).content) as Record<string, string | null>;
      const name = (f: string | null | undefined) => (f ?? '').split(/[\\/]/).pop(); // same content, same file name (the server's are in the temp folder)
      expect(seen).toMatchObject({ HTTPS_PROXY: env.HTTPS_PROXY, NO_PROXY: 'own.example' });
      expect([name(seen.NODE_EXTRA_CA_CERTS), name(seen.SSL_CERT_FILE)]).toEqual([name(env.NODE_EXTRA_CA_CERTS), name(env.SSL_CERT_FILE)]);
    } finally {
      await c.close();
    }

    // with the system store: Node is told to use it too
    configureNetwork({ proxy: null, caFile: null, useSystemCa: true });
    expect(networkChildEnv(join(dir, 'net')).NODE_USE_SYSTEM_CA).toBe('1');
    // nothing set: what the child would inherit from this machine is removed (the settings say none)
    configureNetwork({ proxy: null, caFile: null, useSystemCa: false });
    expect(withNetworkEnv({ PATH: 'p', HTTPS_PROXY: 'http://old:1', NO_PROXY: 'x', SSL_CERT_FILE: 'old.pem', NODE_EXTRA_CA_CERTS: 'old.pem' }, join(dir, 'net'))).toEqual({ PATH: 'p' });
  });
});

describe('readable errors and WSO2', () => {
  /** A stand-in for a gateway that answers with scripted token and model responses. */
  async function gateway(opts: { token: (res: import('node:http').ServerResponse) => void; model?: (res: import('node:http').ServerResponse) => void }) {
    const port = await listen(
      createHttp((req, res) => {
        req.resume();
        if (req.url?.includes('token')) return opts.token(res);
        return (opts.model ?? ((r) => r.writeHead(401).end('{"error":"invalid token"}')))(res);
      }),
    );
    return `http://127.0.0.1:${port}`;
  }
  const wso2 = (base: string) =>
    new Wso2Provider({ id: 'gw', baseUrl: `${base}/v1`, oauth: { tokenUrl: `${base}/token`, clientId: 'client-1', clientSecret: 'secret-1' }, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
  const html = (res: import('node:http').ServerResponse, status: number, title: string) =>
    res.writeHead(status, { 'content-type': 'text/html' }).end(`<!DOCTYPE html><html><head><title>${title}</title></head><body>…</body></html>`);

  it('test connection says which step failed and why, in Chinese', async () => {
    // the token URL shows a login page (a proxy or a wrong address)
    let base = await gateway({ token: (r) => html(r, 200, 'Sign in - Corporate Portal') });
    let r = await probeProvider(wso2(base), { model: 'm' });
    expect(r).toMatchObject({ ok: false, stage: 'token', code: 'wso2.token_bad_response' });
    expect(r.hint).toMatch(/^获取 token 失败：/);
    expect(r.message).toContain('Sign in - Corporate Portal');
    expect(r.message).not.toContain('<html');

    // wrong client id / secret
    base = await gateway({ token: (res) => res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid_client"}') });
    r = await probeProvider(wso2(base), { model: 'm' });
    expect(r).toMatchObject({ stage: 'token', code: 'wso2.token_rejected', errorCode: 'auth' });

    // token fine, the gateway answers the model call with an HTML error page
    const token = (res: import('node:http').ServerResponse) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"access_token":"t1","expires_in":3600}');
    base = await gateway({ token, model: (res) => html(res, 502, 'Bad Gateway') });
    r = await probeProvider(wso2(base), { model: 'm' });
    expect(r).toMatchObject({ stage: 'model', code: 'gateway.html', httpStatus: 502 });
    expect(r.hint).toMatch(/^模型调用失败：网关返回网页/);
    expect(r.message).toContain('"Bad Gateway"');

    // nothing listens there
    r = await probeProvider(openaiProvider(gw, 'x'), { model: 'm' }).then(() => probeProvider(wso2('http://127.0.0.1:9'), { model: 'm' }));
    expect(r).toMatchObject({ stage: 'token', code: 'wso2.token_unreachable' });
  });

  it('a gateway that keeps saying 401 after a fresh token: clock difference is named when there is one', async () => {
    const ahead = new Date(Date.now() + 2 * 3600_000).toUTCString();
    const base = await gateway({
      token: (res) => res.writeHead(200, { 'content-type': 'application/json', date: ahead }).end('{"access_token":"t","expires_in":3600}'),
    });
    const r = await probeProvider(wso2(base), { model: 'm' });
    expect(r).toMatchObject({ stage: 'model', code: 'wso2.clock_skew', httpStatus: 401 });
    expect(r.message).toMatch(/120 minutes behind/);
    const base2 = await gateway({ token: (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"access_token":"t","expires_in":3600}') });
    expect(await probeProvider(wso2(base2), { model: 'm' })).toMatchObject({ code: 'wso2.token_not_accepted' });
  });

  it('WSO2 fault numbers in the error body become their own codes and hints; unknown ones keep the HTTP status code', () => {
    expect(gatewayFaultCode('{"fault":{"code":900908,"message":"Resource forbidden","description":"User is NOT authorized to access the Resource"}}')).toBe('wso2.not_subscribed');
    expect(gatewayFaultCode('{"code":"900901","message":"Invalid Credentials","description":"Access failure for API: /x/v1"}')).toBe('wso2.invalid_credentials');
    expect(
      gatewayFaultCode('<ams:fault xmlns:ams="http://wso2.org/apimanager/security"><ams:code>900910</ams:code><ams:message>The access token does not allow you to access the requested resource</ams:message></ams:fault>'),
    ).toBe('wso2.scope');
    expect(gatewayFaultCode('<fault><code>900802</code><message>Message throttled out</message></fault>')).toBe('wso2.throttled');
    expect(['900800', '900801', '900803', '900804', '900902', '900907', '900909'].map((n) => gatewayFaultCode(`{"code":${n}}`))).toEqual([
      'wso2.throttled',
      'wso2.throttled',
      'wso2.throttled',
      'wso2.throttled',
      'wso2.missing_credentials',
      'wso2.api_blocked',
      'wso2.subscription_inactive',
    ]);
    // not a known fault number, or no fault at all: what the status says
    expect(gatewayFaultCode('{"fault":{"code":900999}}')).toBeUndefined();
    expect(gatewayFaultCode('{"error":{"code":"invalid_api_key"}}')).toBeUndefined();
    expect(httpErrorCode(403, 'application/json', '{"fault":{"code":900999}}')).toBe('gateway.forbidden');
    expect(httpErrorCode(403, 'application/json', '{"fault":{"code":900908}}')).toBe('wso2.not_subscribed');
    for (const c of ['wso2.invalid_credentials', 'wso2.missing_credentials', 'wso2.throttled', 'wso2.not_subscribed', 'wso2.scope', 'wso2.api_blocked', 'wso2.subscription_inactive']) {
      expect(NET_HINTS[c]).toMatch(/WSO2 9008|WSO2 9009/);
    }
    expect(NET_HINTS['wso2.not_subscribed']).toMatch(/WSO2 开发者门户中订阅/);
  });

  it('test connection and model calls name the fault; 900901 gets one new token first', async () => {
    let tokens = 0;
    const token = (res: import('node:http').ServerResponse) => {
      tokens++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(`{"access_token":"t${tokens}","expires_in":3600}`);
    };
    const json = (res: import('node:http').ServerResponse, status: number, body: string) => res.writeHead(status, { 'content-type': 'application/json' }).end(body);
    const xml = (res: import('node:http').ServerResponse, status: number, body: string) => res.writeHead(status, { 'content-type': 'application/xml' }).end(body);

    // not subscribed (JSON fault)
    let base = await gateway({ token, model: (res) => json(res, 403, '{"fault":{"code":900908,"message":"Resource forbidden"}}') });
    let r = await probeProvider(wso2(base), { model: 'm' });
    expect(r).toMatchObject({ ok: false, stage: 'model', code: 'wso2.not_subscribed', errorCode: 'auth', httpStatus: 403 });
    expect(r.hint).toMatch(/^模型调用失败：应用未订阅此 API/);

    // scope too narrow (XML fault)
    base = await gateway({ token, model: (res) => xml(res, 403, '<ams:fault xmlns:ams="http://wso2.org/apimanager/security"><ams:code>900910</ams:code></ams:fault>') });
    expect(await probeProvider(wso2(base), { model: 'm' })).toMatchObject({ code: 'wso2.scope' });

    // throttled
    base = await gateway({ token, model: (res) => json(res, 429, '{"fault":{"code":900802,"message":"Message throttled out"}}') });
    expect(await probeProvider(wso2(base), { model: 'm' })).toMatchObject({ code: 'wso2.throttled', errorCode: 'rate_limited' });

    // 900901 once (the token expired early): a new token, then it works
    tokens = 0;
    let modelCalls = 0;
    base = await gateway({
      token,
      model: (res) => {
        modelCalls++;
        if (modelCalls === 1) return json(res, 401, '{"fault":{"code":900901,"message":"Invalid Credentials"}}');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          'data: {"id":"c","model":"m","choices":[{"index":0,"delta":{"content":"pong"}}]}\n\n' +
            'data: {"id":"c","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
        );
      },
    });
    // (test connection takes the first token, the model call is refused, a second token, then it works)
    expect(await probeProvider(wso2(base), { model: 'm' })).toMatchObject({ ok: true });
    expect({ tokens, modelCalls }).toEqual({ tokens: 2, modelCalls: 2 });

    // 900901 every time: one new token only, then the fault is named
    tokens = 0;
    modelCalls = 0;
    base = await gateway({ token, model: (res) => (modelCalls++, json(res, 401, '{"fault":{"code":900901,"message":"Invalid Credentials"}}')) });
    r = await probeProvider(wso2(base), { model: 'm' });
    expect(r).toMatchObject({ code: 'wso2.invalid_credentials', httpStatus: 401 });
    expect(r.hint).toMatch(/请检查 Consumer Key 和 Consumer Secret/);
    expect({ tokens, modelCalls }).toEqual({ tokens: 2, modelCalls: 2 });
  });

  it('network causes map to stable codes', () => {
    const e = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });
    expect(netErrorCode(e('ENOTFOUND'))).toBe('net.dns');
    expect(netErrorCode(e('ECONNREFUSED'))).toBe('net.refused');
    expect(netErrorCode(e('UND_ERR_CONNECT_TIMEOUT'))).toBe('net.timeout');
    expect(netErrorCode(e('SELF_SIGNED_CERT_IN_CHAIN'))).toBe('tls.untrusted');
    expect(netErrorCode(e('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'))).toBe('tls.untrusted');
    expect(netErrorCode(e('CERT_HAS_EXPIRED'))).toBe('tls.expired');
    expect(netErrorCode(e('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe('tls.name_mismatch');
    expect(netErrorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED', proxyStage: 'connect' }))).toBe('proxy.unreachable');
  });
});
