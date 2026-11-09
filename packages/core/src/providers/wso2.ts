// WSO2 API Manager style gateway: an OpenAI-compatible endpoint behind
// OAuth2 client credentials. Token is fetched on first use, cached until shortly
// before it expires, and fetched again once after a 401.
import type { Tracer } from '../trace.ts';
import { abortError } from '../util.ts';
import { hostOf } from './http.ts';
import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './openai.ts';
import { ProviderError, type AuthSource } from './types.ts';

export interface OAuthClientCredentialsOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /** Send credentials as HTTP Basic (default) or in the form body. */
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
  tracer: Tracer | undefined;

  constructor(opts: OAuthClientCredentialsOptions) {
    this.#o = opts;
  }

  async headers(signal: AbortSignal): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.#get(signal)}` };
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
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (o.scope) form.set('scope', o.scope);
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if ((o.credentialsIn ?? 'basic') === 'basic') {
      headers.authorization = `Basic ${Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64')}`;
    } else {
      form.set('client_id', o.clientId);
      form.set('client_secret', o.clientSecret);
    }
    let res: Response;
    try {
      res = await (o.fetchImpl ?? fetch)(o.tokenUrl, {
        method: 'POST',
        headers,
        body: form.toString(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs ?? 30_000)]),
      });
    } catch (err) {
      trace?.finish({ status: signal.aborted ? 'aborted' : 'error', error: err instanceof Error ? err.message : String(err) });
      if (signal.aborted) throw abortError(signal);
      throw new ProviderError('token endpoint unreachable', { retryable: true });
    }
    if (!res.ok) {
      trace?.finish({ status: 'error', httpStatus: res.status, error: `token request rejected (HTTP ${res.status})` });
      throw new ProviderError(`token request rejected (HTTP ${res.status}); check client id, secret and scope`, {
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      trace?.finish({ status: 'error', httpStatus: res.status, error: 'token response has no access_token' });
      throw new ProviderError('token response has no access_token', { retryable: false });
    }
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
  readonly #oauth: Wso2Options['oauth'];

  constructor(opts: Wso2Options) {
    const auth = new OAuthClientCredentials({
      ...opts.oauth,
      label: `${opts.id}:token`,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    super({ ...opts, auth });
    this.#auth = auth;
    this.#oauth = opts.oauth;
  }

  override secrets(): string[] {
    const o = this.#oauth;
    return [...super.secrets(), o.clientSecret, o.clientId, o.tokenUrl, hostOf(o.tokenUrl)].filter((v): v is string => !!v);
  }

  attach(services: { tracer: Tracer }): void {
    this.#auth.tracer = services.tracer;
  }
}
