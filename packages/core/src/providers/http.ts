// HTTP layer shared by all providers: retry with backoff, timeouts,
// cancellation and one credential refresh after a 401.
import { ProviderError, type AuthSource, type CallInfo } from './types.ts';
import { abortError, redact, sleep } from '../util.ts';
import { htmlTitle, httpErrorCode, looksLikeHtml, netErrorCode, netFetch } from '../net.ts';

export interface RetryPolicy {
  /** Total attempts including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 20_000 };

export interface PostOptions {
  url: string;
  body: string;
  headers: Record<string, string>;
  auth?: AuthSource;
  signal: AbortSignal;
  /** Time allowed until response headers arrive. */
  timeoutMs: number;
  retry: RetryPolicy;
  /** Known secret values to scrub from error messages. */
  secrets?: readonly string[];
  info?: CallInfo;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  fetchImpl?: typeof fetch;
  /** The address the user saved has no version at its end (/v1, /v2...): a 404 says to check that (gateway.not_found_version). */
  unversionedBase?: boolean;
}

/**
 * POST and return a successful response whose body has not been read yet.
 * Retries 408/409/429/5xx and network errors before any body is consumed.
 */
export async function postWithRetry(opts: PostOptions): Promise<Response> {
  const doFetch = opts.fetchImpl ?? netFetch;
  let refreshed = false;
  let lastError: ProviderError | undefined;
  for (let attempt = 1; attempt <= opts.retry.maxAttempts; attempt++) {
    if (opts.signal.aborted) throw abortError(opts.signal);
    if (opts.info) opts.info.attempts = attempt;
    // Soft stop: the caller's signal (user interrupt / stop) never aborts the
    // connection. Before headers we stop waiting and cancel the body when it
    // arrives; after headers the stream reader cancels the body. Only the
    // header timeout aborts hard. (Aborting in-flight requests occasionally
    // crashed Node 24 on Windows; see scripts/diag.)
    const attemptCtl = new AbortController();
    const timer = setTimeout(
      () => attemptCtl.abort(Object.assign(new Error('timed out waiting for response'), { name: 'TimeoutError' })),
      opts.timeoutMs,
    );
    let res: Response;
    let onStop: (() => void) | undefined;
    try {
      const authHeaders = opts.auth ? await opts.auth.headers(opts.signal) : {};
      if (opts.signal.aborted) throw abortError(opts.signal);
      const fetching = doFetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers, ...authHeaders },
        body: opts.body,
        signal: attemptCtl.signal,
      });
      const stopped = new Promise<never>((_, reject) => {
        onStop = () => {
          // Let the request finish on its own; discard the body when it comes.
          fetching.then(
            (r) => {
              clearTimeout(timer);
              void r.body?.cancel().catch(() => {});
            },
            () => clearTimeout(timer),
          );
          reject(abortError(opts.signal));
        };
        opts.signal.addEventListener('abort', onStop, { once: true });
      });
      stopped.catch(() => {});
      res = await Promise.race([fetching, stopped]);
    } catch (err) {
      if (onStop) opts.signal.removeEventListener('abort', onStop);
      if (opts.signal.aborted) throw abortError(opts.signal);
      clearTimeout(timer);
      if (err instanceof ProviderError && !err.retryable) throw err; // e.g. rejected credentials
      const reason = err instanceof Error ? `${err.name}: ${err.message}${causeText(err)}` : 'network error';
      const code = err instanceof ProviderError && err.code ? err.code : netErrorCode(err);
      // a certificate or proxy refusal will not fix itself by retrying
      const retryable = !(code.startsWith('tls.') || code === 'proxy.auth' || code === 'proxy.refused');
      lastError = new ProviderError(redact(`request failed [${code}] (${reason})`, opts.secrets), { retryable, code });
      if (!retryable) throw lastError;
      if (attempt < opts.retry.maxAttempts) {
        const delay = backoff(opts.retry, attempt);
        opts.onRetry?.({ attempt, delayMs: delay, reason });
        await sleep(delay, opts.signal);
        continue;
      }
      throw lastError;
    }
    clearTimeout(timer);
    if (onStop) opts.signal.removeEventListener('abort', onStop);
    if (opts.info) opts.info.httpStatus = res.status;
    if (res.ok) return res;

    const text = await safeText(res);
    let code = httpErrorCode(res.status, res.headers.get('content-type'), text);
    if (code === 'gateway.not_found' && opts.unversionedBase) code = 'gateway.not_found_version'; // most often /v1 is missing
    // rejected credentials (401, or a gateway's "invalid credentials / token expired" fault): get a new token once
    const rejected = res.status === 401 || code === 'wso2.invalid_credentials';
    if (rejected && opts.auth?.refresh && !refreshed) {
      refreshed = true;
      if (await opts.auth.refresh(opts.signal)) {
        attempt--; // the refresh retry does not count against the retry budget
        continue;
      }
    }
    const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
    const html = looksLikeHtml(res.headers.get('content-type'), text);
    // a fresh token was refused too: say why if the token source can tell (clock skew, ...)
    // (a gateway fault that already names the cause keeps its code unless the clock is off)
    const asked = rejected && refreshed && (code === 'gateway.unauthorized' || code === 'wso2.invalid_credentials') ? opts.auth?.diagnose?.() : undefined;
    const diagnosed = asked && (code === 'gateway.unauthorized' || asked.code === 'wso2.clock_skew') ? asked : undefined;
    if (diagnosed) code = diagnosed.code;
    const detail = html
      ? `the gateway returned an HTML page${htmlTitle(text) ? ` "${htmlTitle(text)}"` : ''} instead of API data`
      : text.slice(0, 500);
    const extra = diagnosed ? ` (${diagnosed.detail})` : '';
    lastError = new ProviderError(redact(`HTTP ${res.status} [${code}]: ${detail}${extra}`, opts.secrets), {
      status: res.status,
      retryable,
      code,
    });
    if (!retryable || attempt >= opts.retry.maxAttempts) throw lastError;
    const delay = retryAfterMs(res) ?? backoff(opts.retry, attempt);
    opts.onRetry?.({ attempt, delayMs: delay, reason: `HTTP ${res.status}` });
    await sleep(delay, opts.signal);
  }
  throw lastError ?? new ProviderError('request failed');
}

function causeText(err: Error): string {
  const c = (err as { cause?: unknown }).cause;
  if (!(c instanceof Error)) return '';
  const code = (c as { code?: unknown }).code;
  return ` <- ${typeof code === 'string' ? `${code} ` : ''}${c.message}`;
}

function backoff(p: RetryPolicy, attempt: number): number {
  const exp = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(60_000, Math.max(0, secs * 1000));
  const date = Date.parse(h);
  if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()));
  return undefined;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Host part of a URL for traces; never includes path, query or credentials. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

/** Static header-based credentials. */
export function staticAuth(headers: Record<string, string>): AuthSource {
  return { headers: async () => headers };
}
