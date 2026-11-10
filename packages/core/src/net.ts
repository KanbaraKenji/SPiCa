// Network settings for every outbound request of the core (model providers,
// token endpoints, web_fetch, web_search): a proxy with exceptions and extra
// trusted CA certificates, changeable while running. Company networks usually
// route the internet through a proxy and inspect TLS with their own root CA.
//
// Zero dependencies: requests that go through the proxy use node:http with a
// CONNECT tunnel (TLS to the target inside it); requests that do not use the
// built-in fetch. Extra CAs (a PEM file, and optionally the system store) are
// merged into Node's default trust list, which both paths use.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  /** Certificates trusted beyond Node's own list (system store, CA file). */
  extraCas: string[];
  /** Everything trusted (Node's list + extraCas). */
  allCas: string[];
}

let effective: Effective = { noProxy: [], useSystemCa: false, extraCas: [], allCas: [] };
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
  const next: Effective = { noProxy: [], useSystemCa: cfg.useSystemCa ?? true, extraCas: [], allCas: [] };
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
  const all = [...new Set(cas)];
  const base = new Set(defaultCas);
  tls.setDefaultCACertificates(all);
  next.allCas = all;
  next.extraCas = all.filter((c) => !base.has(c));
  effective = next;
  return { warnings };
}

/**
 * Ports fetch refuses to connect to ("bad port", WHATWG Fetch). Windows hands
 * out local ports from 1024 up by default, so a server listening on port 0 can
 * land on one of these and be unreachable for fetch-based clients.
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/**
 * Listen on a free port that fetch can reach (port 0 = any; a port fetch
 * refuses is given back and another one taken). Resolves with the port.
 */
export async function listenFetchable(server: import('node:net').Server, host = '127.0.0.1', port = 0): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const got = (server.address() as import('node:net').AddressInfo).port;
    if (port !== 0 || !FETCH_BLOCKED_PORTS.has(got) || attempt >= 20) return got;
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** The proxy password, if any (for the redaction table). */
export function networkSecrets(): string[] {
  const p = effective.proxy;
  return p?.password ? [decodeURIComponent(p.password)] : [];
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
const NO_PROXY_VARS = ['NO_PROXY', 'no_proxy'];
const CA_VARS = ['NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'];
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

/** A PEM file with these certificates, named by its content (running processes keep theirs when it changes). */
function pemFile(cas: string[], dir: string): string {
  const pem = `${cas.map((c) => c.trim()).join('\n')}\n`;
  const file = join(dir, `ca-${createHash('sha256').update(pem).digest('hex').slice(0, 16)}.pem`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, pem, 'utf8');
  }
  return file;
}

/**
 * The network settings in force, as environment variables for a child process
 * (plugin MCP servers), so they connect like the app itself: the proxy and its
 * exceptions in the usual variables (upper and lower case; NODE_USE_ENV_PROXY
 * for Node's fetch / http), and when anything is trusted beyond Node's own list
 * (system store, CA file): NODE_EXTRA_CA_CERTS with those certificates
 * (+ NODE_USE_SYSTEM_CA) for Node, and the whole list in SSL_CERT_FILE /
 * REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE for other programs (OpenSSL, Python, curl).
 * A value of undefined means: remove the variable the child would inherit (the
 * settings say there is none). The certificate files go to `dir` (default: the
 * temp folder); they hold public certificates only. Read at process start:
 * processes started after a change get the new settings.
 */
export function networkChildEnv(dir = join(tmpdir(), 'spica-net')): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const p = effective.proxy;
  for (const n of PROXY_VARS) env[n] = p ? p.href : undefined;
  const noProxy = [...new Set([...effective.noProxy, ...LOOPBACK])].join(',');
  for (const n of NO_PROXY_VARS) env[n] = p ? noProxy : undefined;
  env.NODE_USE_ENV_PROXY = p ? '1' : undefined;
  for (const n of CA_VARS) env[n] = undefined;
  if (effective.extraCas.length > 0) {
    env.NODE_EXTRA_CA_CERTS = pemFile(effective.extraCas, dir);
    const bundle = pemFile(effective.allCas, dir);
    env.SSL_CERT_FILE = bundle;
    env.REQUESTS_CA_BUNDLE = bundle;
    env.CURL_CA_BUNDLE = bundle;
  }
  if (effective.useSystemCa) env.NODE_USE_SYSTEM_CA = '1';
  return env;
}

/** Apply networkChildEnv() to an environment (sets and removes variables). */
export function withNetworkEnv(env: Record<string, string>, dir?: string): Record<string, string> {
  const out = { ...env };
  for (const [k, v] of Object.entries(networkChildEnv(dir))) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
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
  'net.dns': 'DNS 解析失败，请检查地址或代理设置。',
  'net.refused': '连接被拒绝，请检查地址和端口。',
  'net.timeout': '连接超时，请检查代理或防火墙设置。',
  'net.reset': '连接中断，请检查代理或防火墙设置。',
  'net.other': '网络错误。',
  'tls.untrusted': '证书不受信任，请在「信任的证书文件」中添加企业根证书，或开启「使用 Windows 证书存储」。',
  'tls.expired': '证书已过期或系统时间不正确。',
  'tls.name_mismatch': '证书名称与地址不匹配，请检查地址或代理。',
  'proxy.unreachable': '无法连接代理，请检查代理地址和端口。',
  'proxy.auth': '代理需要身份验证（HTTP 407），请在代理地址中填写用户名和密码。',
  'proxy.refused': '代理拒绝访问该地址，请将其加入「不使用代理的地址」。',
  'gateway.html': '网关返回网页而非接口数据，请检查地址和代理设置。',
  'gateway.unauthorized': '凭据无效（HTTP 401），请检查 API Key。',
  'gateway.forbidden': '无访问权限（HTTP 403），请检查订阅和模型权限。',
  'gateway.not_found': '路径无效（HTTP 404），请检查接口地址和模型名。',
  // a 404 at an address not ending in a version (test connection: also with /v1 added; a conversation: as saved)
  'gateway.not_found_version': '路径无效（HTTP 404），请检查「接口地址」是否需要以 /v1 结尾。',
  // test connection only: it worked once /v1 was added (the form takes the new address)
  'address.v1_added': '已在「接口地址」末尾补上 /v1，连接成功。',
  'gateway.bad_request': '请求无效（HTTP 400），请检查模型名和参数。',
  'gateway.rate_limited': '请求过于频繁（HTTP 429），请调低「同时请求」。',
  'gateway.server': '服务端错误（HTTP 5xx），请稍后重试。',
  'wso2.token_unreachable': '无法连接取 token 地址。',
  'wso2.token_rejected': '获取 token 被拒绝，请检查 Consumer Key、Consumer Secret 和 Scope。',
  'wso2.token_bad_response': '取 token 地址返回内容无效，请检查地址和代理设置。',
  'wso2.token_not_accepted': '网关拒绝 token，请检查订阅或系统时间。',
  'wso2.clock_skew': '系统时间偏差过大，请校准系统时间。',
  'list.unsupported': '该服务商不支持获取模型列表，请从列表选择或手动输入模型。',
  'list.bad_response': '模型列表格式无效，请从列表选择或手动输入模型。',
  // fault numbers in a WSO2 API gateway's error body (see gatewayFaultCode)
  'wso2.invalid_credentials': '凭据无效或 token 已过期（WSO2 900901），请检查 Consumer Key 和 Consumer Secret。',
  'wso2.missing_credentials': '请求缺少凭据（WSO2 900902），请填写 API Key，或将服务商改为公司网关（WSO2）。',
  'wso2.throttled': '调用额度已用完（WSO2 900800–900804），请稍后重试或调低「同时请求」。',
  'wso2.not_subscribed': '应用未订阅此 API（WSO2 900908），请在 WSO2 开发者门户中订阅。',
  'wso2.scope': 'token 权限范围不足（WSO2 900910），请在 Scope 中填写所需范围。',
  'wso2.api_blocked': 'API 已被网关暂停（WSO2 900907），请联系网关管理员。',
  'wso2.subscription_inactive': '订阅未生效（WSO2 900909），请在 WSO2 开发者门户中查看订阅状态。',
};

/** What the settings form calls a connection's address, by its kind (the hints name the field the user sees). */
export const ADDRESS_FIELD: Readonly<Record<string, string>> = { 'openai-compatible': '接口地址', anthropic: '接口地址', wso2: '网关地址' };

/**
 * The words for a code (NET_HINTS) as the user of this kind of connection reads them: the address field under
 * its own name (a WSO2 gateway's is 网关地址). The one place the field name is chosen.
 */
export function netHint(code: string | undefined, kind?: string): string | undefined {
  const hint = code ? NET_HINTS[code] : undefined;
  if (!hint) return undefined;
  const field = (kind && ADDRESS_FIELD[kind]) || '接口地址';
  return field === '接口地址' ? hint : hint.replaceAll('接口地址', field);
}

const WSO2_FAULTS: Record<string, string> = {
  '900901': 'wso2.invalid_credentials',
  '900902': 'wso2.missing_credentials',
  '900800': 'wso2.throttled',
  '900801': 'wso2.throttled', // hard limit (503)
  '900802': 'wso2.throttled',
  '900803': 'wso2.throttled',
  '900804': 'wso2.throttled', // subscription level (429)
  '900907': 'wso2.api_blocked',
  '900908': 'wso2.not_subscribed',
  '900909': 'wso2.subscription_inactive',
  '900910': 'wso2.scope',
};

/**
 * Code for a WSO2 API gateway fault in an error body, when it carries one of
 * the known fault numbers: JSON `{"fault":{"code":900901,…}}` or `{"code":"900908",…}`,
 * or XML `<ams:fault><ams:code>900901</ams:code>…`. Unknown numbers and other bodies: undefined.
 */
export function gatewayFaultCode(body: string): string | undefined {
  let n: string | undefined;
  try {
    const j = JSON.parse(body) as { code?: unknown; fault?: { code?: unknown } } | null;
    const c = j && typeof j === 'object' ? (j.fault && typeof j.fault === 'object' ? j.fault.code : j.code) : undefined;
    if (typeof c === 'number' || typeof c === 'string') n = String(c).trim();
  } catch {
    n = /<(?:[\w-]+:)?code>\s*(\d{6})\s*<\/(?:[\w-]+:)?code>/.exec(body)?.[1];
  }
  return n ? WSO2_FAULTS[n] : undefined;
}

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
  const fault = gatewayFaultCode(body);
  if (fault) return fault;
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
