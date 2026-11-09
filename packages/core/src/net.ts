// Network settings for every outbound request of the core (model providers,
// token endpoints, web_fetch, web_search): a proxy with exceptions and extra
// trusted CA certificates, changeable while running. Company networks usually
// route the internet through a proxy and inspect TLS with their own root CA.
//
// Zero dependencies: requests that go through the proxy use node:http with a
// CONNECT tunnel (TLS to the target inside it); requests that do not use the
// built-in fetch. Extra CAs (a PEM file, and optionally the system store) are
// merged into Node's default trust list, which both paths use.
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import * as tls from 'node:tls';

export interface NetworkConfig {
  /** null = no proxy (also ignores HTTPS_PROXY); undefined = take HTTPS_PROXY / HTTP_PROXY / NO_PROXY from the environment. */
  proxy?: { url: string; noProxy?: string[] } | null;
  /** PEM file with extra root certificates (e.g. the company's TLS inspection CA). null = none; undefined = none besides NODE_EXTRA_CA_CERTS. */
  caFile?: string | null;
  /** Also trust the operating system's certificate store (default true; on Windows it usually holds the company CA). */
  useSystemCa?: boolean;
}

interface Effective {
  proxy?: URL;
  noProxy: string[];
  caFile?: string;
  useSystemCa: boolean;
}

let effective: Effective = { noProxy: [], useSystemCa: false };
let defaultCas: string[] | undefined;

/** What is in force now (the proxy without its password), for the settings page and logs. */
export function networkStatus(): { proxy: string | null; noProxy: string[]; caFile: string | null; useSystemCa: boolean } {
  const p = effective.proxy;
  return {
    proxy: p ? `${p.protocol}//${p.username ? '***@' : ''}${p.host}` : null,
    noProxy: [...effective.noProxy],
    caFile: effective.caFile ?? null,
    useSystemCa: effective.useSystemCa,
  };
}

/**
 * Apply network settings (also while running: the next request uses them).
 * Environment variables fill what the settings leave undefined: HTTPS_PROXY /
 * HTTP_PROXY / NO_PROXY; NODE_EXTRA_CA_CERTS is honoured by Node itself.
 * Returns warnings (e.g. a CA file that cannot be read); never throws.
 */
export function configureNetwork(cfg: NetworkConfig = {}, env: NodeJS.ProcessEnv = process.env): { warnings: string[] } {
  const warnings: string[] = [];
  const next: Effective = { noProxy: [], useSystemCa: cfg.useSystemCa ?? true };
  const raw =
    cfg.proxy === null
      ? undefined
      : (cfg.proxy?.url ?? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? undefined);
  if (raw) {
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`unsupported proxy scheme ${u.protocol}`);
      next.proxy = u;
    } catch (err) {
      warnings.push(`proxy ignored: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const noProxy = cfg.proxy ? (cfg.proxy.noProxy ?? []) : (env.NO_PROXY ?? env.no_proxy ?? '').split(/[,\s]+/);
  next.noProxy = noProxy.map((s) => s.trim().toLowerCase()).filter(Boolean);

  // trust: Node's defaults (bundled + NODE_EXTRA_CA_CERTS), plus the system store, plus the CA file
  defaultCas ??= tls.getCACertificates('default');
  const cas = [...defaultCas];
  if (next.useSystemCa) {
    try {
      cas.push(...tls.getCACertificates('system'));
    } catch (err) {
      warnings.push(`system certificates not available: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (cfg.caFile) {
    try {
      const pem = readFileSync(cfg.caFile, 'utf8');
      const found = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
      if (found.length === 0) warnings.push(`no certificate found in ${cfg.caFile} (it must be PEM text)`);
      cas.push(...found);
      next.caFile = cfg.caFile;
    } catch (err) {
      warnings.push(`CA file not read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  tls.setDefaultCACertificates([...new Set(cas)]);
  effective = next;
  return { warnings };
}

/** The proxy for a URL, or undefined when it goes direct (no proxy, or listed in noProxy). */
export function proxyFor(url: URL): URL | undefined {
  const p = effective.proxy;
  if (!p) return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  for (const rule of effective.noProxy) {
    if (rule === '*') return undefined;
    const [rHost, rPort] = rule.startsWith('[') ? [rule.slice(1, rule.indexOf(']')), rule.split(']:')[1]] : rule.split(':');
    if (rPort && rPort !== port) continue;
    const h = (rHost ?? '').replace(/^\*\./, '.');
    if (!h) continue;
    if (isIP(h) ? host === h : host === h.replace(/^\./, '') || host.endsWith(h.startsWith('.') ? h : `.${h}`)) return undefined;
  }
  return p;
}

/** fetch with the network settings applied. Same contract as the built-in fetch. */
export const netFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const proxy = proxyFor(url);
  if (!proxy) return fetch(input, init);
  return proxiedFetch(new Request(input, init), proxy, (init?.redirect as 'follow' | 'manual' | 'error' | undefined) ?? 'follow', 0);
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

async function proxiedFetch(req: Request, proxy: URL, redirect: 'follow' | 'manual' | 'error', hops: number): Promise<Response> {
  const url = new URL(req.url);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
  const headers: OutgoingHttpHeaders = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  headers.host = url.host;
  // one request per tunnel: close it when the response ends (no sockets left behind)
  headers.connection = 'close';
  if (body) headers['content-length'] = String(body.length);
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const signal = req.signal;
    if (signal.aborted) return reject(signal.reason);
    const fail = (err: unknown) => reject(err);
    const send = (opts: RequestOptions) => {
      const r = httpRequest(opts, resolve);
      r.on('error', fail);
      signal.addEventListener('abort', () => r.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted')), { once: true });
      r.end(body);
    };
    if (url.protocol === 'http:') {
      // plain HTTP: ask the proxy for the absolute URL
      send({ ...proxyTarget(proxy), method: req.method, path: url.href, headers: { ...headers, ...proxyAuth(proxy) } });
      return;
    }
    // HTTPS: CONNECT tunnel, then TLS to the target inside it
    const port = Number(url.port || 443);
    const connect = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
      ...proxyTarget(proxy),
      method: 'CONNECT',
      path: `${url.hostname}:${port}`,
      headers: { host: `${url.hostname}:${port}`, ...proxyAuth(proxy) },
    });
    signal.addEventListener('abort', () => connect.destroy(), { once: true });
    connect.on('error', (err) => fail(Object.assign(err, { proxyStage: 'connect' })));
    connect.on('connect', (cres, socket) => {
      if (cres.statusCode !== 200) {
        socket.destroy();
        fail(Object.assign(new Error(`proxy refused the tunnel (HTTP ${cres.statusCode})`), { code: cres.statusCode === 407 ? 'PROXY_AUTH' : 'PROXY_REFUSED', status: cres.statusCode }));
        return;
      }
      const secure = tls.connect({ socket, servername: isIP(url.hostname) ? undefined : url.hostname, ALPNProtocols: ['http/1.1'] });
      secure.on('error', fail);
      secure.once('secureConnect', () =>
        send({ host: url.hostname, port, method: req.method, path: `${url.pathname}${url.search}`, headers, createConnection: () => secure }),
      );
    });
    connect.end();
  });

  const status = res.statusCode ?? 0;
  const location = res.headers.location;
  if (redirect !== 'manual' && REDIRECTS.has(status) && location) {
    res.resume();
    if (redirect === 'error') throw new TypeError(`redirect to ${location}`);
    if (hops >= 20) throw new TypeError('too many redirects');
    const next = new URL(location, url);
    const keepBody = status === 307 || status === 308;
    const init: RequestInit = { method: keepBody ? req.method : 'GET', headers: req.headers, signal: req.signal, redirect, ...(keepBody && body ? { body } : {}) };
    const nextProxy = proxyFor(next);
    return nextProxy ? proxiedFetch(new Request(next, init), nextProxy, redirect, hops + 1) : fetch(next, init);
  }
  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) out.append(k, one);
  }
  const noBody = req.method === 'HEAD' || status === 204 || status === 304 || status < 200;
  if (noBody) res.resume();
  req.signal.addEventListener('abort', () => res.destroy(), { once: true });
  return new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status: status < 200 ? 502 : status, statusText: res.statusMessage ?? '', headers: out });
}

function proxyTarget(proxy: URL): { host: string; port: number } {
  return { host: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)) };
}

function proxyAuth(proxy: URL): Record<string, string> {
  if (!proxy.username) return {};
  const user = decodeURIComponent(proxy.username);
  const pass = decodeURIComponent(proxy.password);
  return { 'proxy-authorization': `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

// ---------------------------------------------------------------------------
// Readable errors: a stable code plus a Chinese hint (shown by the settings
// page's "test connection"; the code is what logs and UIs key on).
// ---------------------------------------------------------------------------

export const NET_HINTS: Record<string, string> = {
  'net.dns': '找不到这个地址（DNS 解析失败）。检查地址拼写；公司网络里访问外网通常要配代理。',
  'net.refused': '对方拒绝连接：地址或端口不对，或服务没有开。',
  'net.timeout': '连接超时：多半是要配代理，或者防火墙拦了这个地址。',
  'net.reset': '连接被中途断开：常见于代理或防火墙拦截。',
  'net.other': '网络错误。',
  'tls.untrusted': '证书不受信任：公司网络检查 HTTPS 时会换上公司自己的证书。把公司根证书（PEM）配到「网络 → 证书文件」，或打开「使用系统证书」。',
  'tls.expired': '对方证书已过期，或本机时间不对。',
  'tls.name_mismatch': '证书上的名字和访问的地址对不上：地址写错了，或代理换了证书。',
  'proxy.unreachable': '连不上代理：代理地址或端口不对，或代理没开。',
  'proxy.auth': '代理要求登录（HTTP 407）：在代理地址里写上「用户名:密码@」，或向 IT 要不用登录的代理。',
  'proxy.refused': '代理拒绝转发到这个地址：可能被公司网络禁止，或要把它加进「不走代理」。',
  'gateway.html': '网关返回了一个网页而不是接口数据：多半是代理拦截页、登录页或网关的错误页。检查地址和代理设置。',
  'gateway.unauthorized': '网关拒绝了凭据（HTTP 401）：key 不对或已失效。',
  'gateway.forbidden': '网关不允许这次调用（HTTP 403）：应用没有订阅这个接口，或没有这个模型的权限。',
  'gateway.not_found': '路径不对（HTTP 404）：检查地址（通常要带到 /v1 一类的路径）和模型名。',
  'gateway.bad_request': '请求被拒（HTTP 400）：模型名或参数不被接受。',
  'gateway.rate_limited': '调用太频繁（HTTP 429），已自动重试；仍失败就调低并发。',
  'gateway.server': '网关或模型服务出错（HTTP 5xx），已自动重试。',
  'wso2.token_unreachable': '连不上取 token 的地址（见网络原因）。',
  'wso2.token_rejected': '取 token 被拒：client id、client secret 或 scope 不对，或这个应用没开 client credentials。',
  'wso2.token_bad_response': '取 token 的地址返回的不是 token：多半是 token 地址写错了，或被代理拦截页、登录页替换了。',
  'wso2.token_not_accepted': '网关不接受新取的 token（重取后仍是 401）：应用没有订阅这个接口，或本机时间偏差太大。',
  'wso2.clock_skew': '本机时间和网关相差太多：token 可能被判成过期或还没生效。请校准系统时间。',
};

/** Code for an error thrown by fetch / node:http / tls (looks through `cause`). */
export function netErrorCode(err: unknown): string {
  const codes: string[] = [];
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') codes.push(c);
  }
  const viaProxy = !!(err as { proxyStage?: string })?.proxyStage;
  for (const c of codes) {
    if (c === 'PROXY_AUTH') return 'proxy.auth';
    if (c === 'PROXY_REFUSED') return 'proxy.refused';
    if (viaProxy && (c === 'ECONNREFUSED' || c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'ETIMEDOUT')) return 'proxy.unreachable';
    if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'net.dns';
    if (c === 'ECONNREFUSED') return 'net.refused';
    if (c === 'ETIMEDOUT' || c === 'UND_ERR_CONNECT_TIMEOUT' || c === 'ESOCKETTIMEDOUT') return 'net.timeout';
    if (c === 'ECONNRESET' || c === 'UND_ERR_SOCKET' || c === 'EPIPE') return 'net.reset';
    if (/SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY|CERT_UNTRUSTED|CERT_SIGNATURE_FAILURE/.test(c)) return 'tls.untrusted';
    if (c === 'CERT_HAS_EXPIRED' || c === 'CERT_NOT_YET_VALID') return 'tls.expired';
    if (c === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'tls.name_mismatch';
  }
  return 'net.other';
}

/** Code for an unsuccessful HTTP response from a gateway or model API. */
export function httpErrorCode(status: number, contentType: string | null, body: string): string {
  if (looksLikeHtml(contentType, body)) return 'gateway.html';
  if (status === 401) return 'gateway.unauthorized';
  if (status === 403) return 'gateway.forbidden';
  if (status === 404) return 'gateway.not_found';
  if (status === 429) return 'gateway.rate_limited';
  if (status >= 500) return 'gateway.server';
  return 'gateway.bad_request';
}

export function looksLikeHtml(contentType: string | null, body: string): boolean {
  return /text\/html/i.test(contentType ?? '') || /^\s*(<!doctype html|<html[\s>])/i.test(body);
}

/** The <title> of an HTML error page, to say which page came back. */
export function htmlTitle(body: string): string | undefined {
  const t = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, ' ').trim();
  return t || undefined;
}
