// WSO2 API Manager style gateway: an OpenAI-compatible endpoint behind
// OAuth2 client credentials. Token is fetched on first use, cached until shortly
// before it expires, and fetched again once after a 401.
import type { Tracer } from '../trace.ts';
import { abortError } from '../util.ts';
import { looksLikeHtml, htmlTitle, netErrorCode, netFetch } from '../net.ts';
import { hostOf } from './http.ts';
import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './openai.ts';
import { ProviderError, type AuthSource } from './types.ts';

export interface OAuthClientCredentialsOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /**
   * Send credentials as HTTP Basic or in the form body. Left out: Basic first, and the form body once when the
   * token endpoint refuses Basic (some gateways take only one of them); the one that worked is kept.
   */
  credentialsIn?: 'basic' | 'body';
  /** Refresh this long before expiry. Default 60 s. */
  refreshSkewMs?: number;
  timeoutMs?: number;
  /** Used to label traces. */
  label?: string;
  traceHost?: boolean;
  fetchImpl?: typeof fetch;
}

export class OAuthClientCredentials implements AuthSource {
  readonly #o: OAuthClientCredentialsOptions;
  #token: { value: string; expiresAt: number } | undefined;
  #inflight: Promise<string> | undefined;
  /** Gateway clock minus ours, from the Date header of the last token response. */
  #skewMs = 0;
  /** Where the credentials go: as configured, else found out by the first token request. */
  #credsIn: 'basic' | 'body' | undefined;
  tracer: Tracer | undefined;

  constructor(opts: OAuthClientCredentialsOptions) {
    this.#o = opts;
    this.#credsIn = opts.credentialsIn;
  }

  async headers(signal: AbortSignal): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.#get(signal)}` };
  }

  /** Get a fresh token now (test connection); throws a ProviderError with a wso2.* code. */
  async check(signal: AbortSignal): Promise<void> {
    this.#token = undefined;
    await this.#get(signal);
  }

  diagnose(): { code: string; detail: string } {
    const minutes = Math.round(this.#skewMs / 60_000);
    if (Math.abs(this.#skewMs) > 5 * 60_000) {
      return { code: 'wso2.clock_skew', detail: `this computer's clock is ${Math.abs(minutes)} minutes ${minutes > 0 ? 'behind' : 'ahead of'} the gateway` };
    }
    return { code: 'wso2.token_not_accepted', detail: 'the gateway rejected a freshly issued token: check the subscription of the application to this API' };
  }

  async refresh(signal: AbortSignal): Promise<boolean> {
    this.#token = undefined;
    try {
      await this.#get(signal);
      return true;
    } catch (err) {
      if (signal.aborted) throw err;
      return false;
    }
  }

  #get(signal: AbortSignal): Promise<string> {
    const skew = this.#o.refreshSkewMs ?? 60_000;
    if (this.#token && this.#token.expiresAt - skew > Date.now()) return Promise.resolve(this.#token.value);
    // Concurrent callers share one token request.
    this.#inflight ??= this.#fetch(signal).finally(() => (this.#inflight = undefined));
    return this.#inflight;
  }

  async #fetch(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw abortError(signal);
    const o = this.#o;
    const trace = this.tracer?.start({
      kind: 'auth',
      sessionId: null,
      parentChain: [],
      initiator: 'runtime',
      target: o.traceHost ? hostOf(o.tokenUrl) : (o.label ?? 'oauth'),
    });
    const request = (credsIn: 'basic' | 'body') => {
      const form = new URLSearchParams({ grant_type: 'client_credentials' });
      if (o.scope) form.set('scope', o.scope);
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
      if (credsIn === 'basic') {
        headers.authorization = `Basic ${Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64')}`;
      } else {
        form.set('client_id', o.clientId);
        form.set('client_secret', o.clientSecret);
      }
      return (o.fetchImpl ?? netFetch)(o.tokenUrl, {
        method: 'POST',
        headers,
        body: form.toString(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs ?? 30_000)]),
      });
    };
    let credsIn = this.#credsIn ?? 'basic';
    let res: Response;
    try {
      res = await request(credsIn);
      // not configured and Basic refused (not an HTML page): some gateways take the credentials only in the form body
      if (!this.#credsIn && (res.status === 400 || res.status === 401) && !/text\/html/i.test(res.headers.get('content-type') ?? '')) {
        await res.text().catch(() => '');
        credsIn = 'body';
        res = await request(credsIn);
      }
    } catch (err) {
      trace?.finish({ status: signal.aborted ? 'aborted' : 'error', error: err instanceof Error ? err.message : String(err) });
      if (signal.aborted) throw abortError(signal);
      const net = netErrorCode(err);
      throw new ProviderError(`token endpoint unreachable [wso2.token_unreachable / ${net}]`, {
        retryable: !net.startsWith('tls.') && net !== 'proxy.auth',
        code: net.startsWith('tls.') || net.startsWith('proxy.') ? net : 'wso2.token_unreachable',
      });
    }
    const date = Date.parse(res.headers.get('date') ?? '');
    if (Number.isFinite(date)) this.#skewMs = date - Date.now();
    const text = await res.text().catch(() => '');
    const html = looksLikeHtml(res.headers.get('content-type'), text);
    if (!res.ok) {
      const code = html ? 'wso2.token_bad_response' : res.status === 429 || res.status >= 500 ? 'gateway.server' : 'wso2.token_rejected';
      const what = html ? `an HTML page${htmlTitle(text) ? ` "${htmlTitle(text)}"` : ''}` : `HTTP ${res.status}`;
      trace?.finish({ status: 'error', httpStatus: res.status, error: `token request rejected (${what})` });
      throw new ProviderError(`token request rejected (HTTP ${res.status}) [${code}]; ${html ? `the token URL returned ${what}` : 'check client id, secret and scope'}`, {
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        code,
      });
    }
    let body: { access_token?: unknown; expires_in?: unknown } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // handled below
    }
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      const what = html ? `an HTML page${htmlTitle(text) ? ` "${htmlTitle(text)}"` : ''}` : text.trim() ? 'something that is not a token' : 'an empty body';
      trace?.finish({ status: 'error', httpStatus: res.status, error: `token response has no access_token (${what})` });
      throw new ProviderError(`token response has no access_token [wso2.token_bad_response]: the token URL returned ${what}`, { retryable: false, code: 'wso2.token_bad_response' });
    }
    this.#credsIn ??= credsIn; // the way that worked, for the next tokens
    const ttl = Number(body.expires_in);
    this.#token = { value: body.access_token, expiresAt: Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 3_600_000) };
    trace?.finish({ status: 'ok', httpStatus: res.status });
    return body.access_token;
  }
}

export interface Wso2Options extends Omit<OpenAICompatibleOptions, 'auth' | 'apiKey'> {
  oauth: Omit<OAuthClientCredentialsOptions, 'fetchImpl' | 'label'>;
}

/** OpenAI-compatible provider whose credentials come from OAuth2 client credentials. */
export class Wso2Provider extends OpenAICompatibleProvider {
  override readonly kind: string = 'wso2';
  readonly #auth: OAuthClientCredentials;

  constructor(opts: Wso2Options) {
    const auth = new OAuthClientCredentials({
      ...opts.oauth,
      label: `${opts.id}:token`,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    super({ ...opts, auth });
    this.#auth = auth;
  }

  attach(services: { tracer: Tracer }): void {
    this.#auth.tracer = services.tracer;
  }

  checkAuth(signal: AbortSignal): Promise<void> {
    return this.#auth.check(signal);
  }
}
