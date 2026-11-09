// HTTP layer shared by all providers: retry with backoff, timeouts,
// cancellation and one credential refresh after a 401.
import { ProviderError, type AuthSource, type CallInfo } from './types.ts';
import { abortError, redact, sleep } from '../util.ts';

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
}

/**
 * POST and return a successful response whose body has not been read yet.
 * Retries 408/409/429/5xx and network errors before any body is consumed.
 */
export async function postWithRetry(opts: PostOptions): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  let refreshed = false;
  let lastError: ProviderError | undefined;
  for (let attempt = 1; attempt <= opts.retry.maxAttempts; attempt++) {
    if (opts.signal.aborted) throw abortError(opts.signal);
    if (opts.info) opts.info.attempts = attempt;
    // Header timeout: aborts only this attempt; the body stream is governed
    // by the caller's signal and the stream idle timeout.
    const attemptCtl = new AbortController();
    const onOuterAbort = () => attemptCtl.abort(opts.signal.reason);
    opts.signal.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(
      () => attemptCtl.abort(Object.assign(new Error('timed out waiting for response'), { name: 'TimeoutError' })),
      opts.timeoutMs,
    );
    let res: Response;
    try {
      const authHeaders = opts.auth ? await opts.auth.headers(opts.signal) : {};
      res = await doFetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers, ...authHeaders },
        body: opts.body,
        signal: attemptCtl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onOuterAbort);
      if (opts.signal.aborted) throw abortError(opts.signal);
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : 'network error';
      lastError = new ProviderError(redact(`request failed (${reason})`, opts.secrets), { retryable: true });
      if (attempt < opts.retry.maxAttempts) {
        const delay = backoff(opts.retry, attempt);
        opts.onRetry?.({ attempt, delayMs: delay, reason });
        await sleep(delay, opts.signal);
        continue;
      }
      throw lastError;
    }
    clearTimeout(timer);
    // From here on the body is cancelled only by the caller's signal (the
    // listener above stays attached for that).
    if (opts.info) opts.info.httpStatus = res.status;
    if (res.ok) return res;

    const text = await safeText(res);
    opts.signal.removeEventListener('abort', onOuterAbort);
    if (res.status === 401 && opts.auth?.refresh && !refreshed) {
      refreshed = true;
      if (await opts.auth.refresh(opts.signal)) {
        attempt--; // the refresh retry does not count against the retry budget
        continue;
      }
    }
    const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
    lastError = new ProviderError(redact(`HTTP ${res.status}: ${text.slice(0, 500)}`, opts.secrets), {
      status: res.status,
      retryable,
    });
    if (!retryable || attempt >= opts.retry.maxAttempts) throw lastError;
    const delay = retryAfterMs(res) ?? backoff(opts.retry, attempt);
    opts.onRetry?.({ attempt, delayMs: delay, reason: `HTTP ${res.status}` });
    await sleep(delay, opts.signal);
  }
  throw lastError ?? new ProviderError('request failed');
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
