// "Test connection": one minimal request to a provider, outside any session.
import type { Tracer } from '../trace.ts';
import type { ProbeResult } from '../types.ts';
import { isAbortError, redact } from '../util.ts';
import { ProviderError, type Provider } from './types.ts';

export interface ProbeOptions {
  model: string;
  /** Give up after this long. Default 20 s. */
  timeoutMs?: number;
  /** Leave a traceable record (initiator runtime:probe). */
  tracer?: Tracer;
  signal?: AbortSignal;
}

/**
 * Send one tiny request ("ping", a few output tokens) and report whether the
 * provider answered, how long it took and which model the server named.
 * The result is structured; UIs write their own message from `errorCode`.
 */
export async function probeProvider(provider: Provider, opts: ProbeOptions): Promise<ProbeResult> {
  const t0 = performance.now();
  const trace = opts.tracer?.start({
    kind: 'model',
    sessionId: null,
    parentChain: [],
    initiator: 'runtime:probe',
    target: provider.traceTarget,
    providerId: provider.id,
    model: opts.model,
  });
  const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 20_000), ...(opts.signal ? [opts.signal] : [])]);
  const info = { attempts: 0 };
  try {
    let model: string | undefined;
    let firstByteMs: number | undefined;
    for await (const ev of provider.stream(
      {
        model: opts.model,
        system: '',
        messages: [{ id: 'probe', sessionId: 'probe', seq: 1, role: 'user', kind: 'user', content: [{ type: 'text', text: 'ping' }], createdAt: '' }],
        tools: [],
        maxTokens: 16,
      },
      { signal, info },
    )) {
      firstByteMs ??= Math.round(performance.now() - t0);
      if (ev.type === 'response') model = ev.response.model;
    }
    const latencyMs = Math.round(performance.now() - t0);
    trace?.finish({ status: 'ok', attempts: info.attempts, ...(model ? { model } : {}) });
    return { ok: true, latencyMs, firstByteMs: firstByteMs ?? latencyMs, ...(model ? { model } : {}) };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    const status = err instanceof ProviderError ? err.status : undefined;
    const message = redact(err instanceof Error ? err.message : String(err)).slice(0, 300);
    const timedOut = signal.aborted && !opts.signal?.aborted;
    const errorCode: ProbeResult['errorCode'] = timedOut
      ? 'timeout'
      : isAbortError(err)
        ? 'aborted'
        : status === 401 || status === 403
          ? 'auth'
          : status === 404
            ? 'not_found'
            : status === 429
              ? 'rate_limited'
              : status !== undefined && status >= 500
                ? 'server'
                : status !== undefined && status >= 400
                  ? 'bad_request'
                  : /token request rejected/.test(message)
                    ? 'auth'
                    : 'network';
    trace?.finish({ status: errorCode === 'aborted' ? 'aborted' : 'error', error: message, attempts: info.attempts, ...(status ? { httpStatus: status } : {}) });
    return { ok: false, latencyMs, errorCode, ...(status ? { httpStatus: status } : {}), message };
  }
}
