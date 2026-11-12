// Traceable records: one per external request (model, search, fetch, MCP, auth),
// and for model calls one request record per HTTP attempt (the usage page and the monitor read those).
import type { RequestRecord, TraceKind, TraceRecord } from './types.ts';
import type { AttemptReport, CallInfo } from './providers/types.ts';
import type { Store } from './store/types.ts';
import type { EventBus } from './events.ts';
import { isoNow } from './events.ts';
import { newId, redact } from './util.ts';

export interface TraceStart {
  kind: TraceKind;
  sessionId: string | null;
  parentChain: string[];
  initiator: string;
  target: string;
  providerId?: string;
  model?: string;
  confirmedBy?: 'user' | 'view' | 'none';
  changes?: string[];
}

export type TraceFinish = Partial<
  Pick<
    TraceRecord,
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheReadTokens'
    | 'cacheWriteTokens'
    | 'bytes'
    | 'costUsd'
    | 'unpriced'
    | 'httpStatus'
    | 'attempts'
    | 'error'
    | 'errorCode'
    | 'model'
  >
> & { status: TraceRecord['status'] };

export interface TraceHandle {
  readonly id: string;
  /**
   * Keep a request record of every HTTP attempt this call makes: the attempts that fail as they fail
   * (CallInfo.onAttempt), the one that answered when the call finishes (with its tokens). Returns `info`.
   */
  watch(info: CallInfo): CallInfo;
  finish(result: TraceFinish): TraceRecord;
}

/** The request log keeps this many records; older ones are dropped (about 40 MB at most). */
export const REQUEST_LOG_MAX = 100_000;
/** Drop the oldest records once every this many new ones (and when the core starts). */
const PRUNE_EVERY = 500;

export class Tracer {
  readonly #store: Store;
  readonly #bus: EventBus | undefined;

  readonly #scrub: (text: string) => string;

  /** `scrub` removes known secrets from error texts (default: pattern-based redaction only). */
  #sinceprune = 0;

  constructor(store: Store, bus?: EventBus, scrub: (text: string) => string = (t) => redact(t)) {
    this.#store = store;
    this.#bus = bus;
    this.#scrub = scrub;
    this.#store.pruneRequests(REQUEST_LOG_MAX);
  }

  #request(rec: RequestRecord): void {
    const clean: RequestRecord = rec.error ? { ...rec, error: this.#scrub(rec.error).slice(0, 300) } : rec;
    try {
      this.#store.appendRequest(clean);
      if (++this.#sinceprune >= PRUNE_EVERY) {
        this.#sinceprune = 0;
        this.#store.pruneRequests(REQUEST_LOG_MAX);
      }
    } catch {
      // the log must never break a call
    }
    this.#bus?.emit({ sessionId: rec.sessionId ?? '', parentChain: [] }, { type: 'request', record: clean });
  }

  start(start: TraceStart): TraceHandle {
    const id = newId('tr');
    const startedAt = isoNow();
    const t0 = performance.now();
    let done = false;
    let watched: CallInfo | undefined;
    const base = (): Omit<RequestRecord, 'id' | 'startedAt' | 'durationMs' | 'attempt' | 'status'> => ({
      traceId: id,
      sessionId: start.sessionId,
      initiator: start.initiator,
      ...(start.providerId ? { providerId: start.providerId } : {}),
      ...(start.model ? { model: start.model } : {}),
    });
    return {
      id,
      watch: (info) => {
        watched = info;
        info.onAttempt = (a: AttemptReport) =>
          this.#request({
            id: newId('rq'),
            ...base(),
            startedAt: a.startedAt,
            durationMs: a.durationMs,
            attempt: a.attempt,
            ...(a.retried ? { retried: true as const } : {}),
            status: a.status,
            ...(a.httpStatus ? { httpStatus: a.httpStatus } : {}),
            ...(a.code ? { errorCode: a.code } : {}),
            ...(a.error ? { error: a.error } : {}),
          });
        return info;
      },
      finish: (result) => {
        const answering = watched?.answering;
        if (answering && !done) {
          watched!.answering = undefined;
          const r = result;
          this.#request({
            id: newId('rq'),
            ...base(),
            ...(r.model ? { model: r.model } : {}),
            startedAt: answering.startedAt,
            durationMs: Math.round(performance.now() - answering.t0),
            attempt: answering.attempt,
            status: r.status,
            ...(watched!.httpStatus ? { httpStatus: watched!.httpStatus } : {}),
            ...(r.errorCode ? { errorCode: r.errorCode } : {}),
            ...(r.error ? { error: r.error } : {}),
            ...(r.inputTokens !== undefined ? { inputTokens: r.inputTokens } : {}),
            ...(r.outputTokens !== undefined ? { outputTokens: r.outputTokens } : {}),
            ...(r.cacheReadTokens !== undefined ? { cacheReadTokens: r.cacheReadTokens } : {}),
            ...(r.cacheWriteTokens !== undefined ? { cacheWriteTokens: r.cacheWriteTokens } : {}),
            ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
            ...(r.unpriced ? { unpriced: true as const } : {}),
          });
        }
        const rec: TraceRecord = {
          id,
          startedAt,
          durationMs: Math.round(performance.now() - t0),
          ...start,
          ...result,
          ...(result.error ? { error: this.#scrub(result.error).slice(0, 300) } : {}),
        };
        if (!done) {
          done = true;
          this.#store.appendTrace(rec);
          if (rec.sessionId) this.#bus?.emit({ sessionId: rec.sessionId, parentChain: rec.parentChain }, { type: 'trace', record: rec });
        }
        return rec;
      },
    };
  }

  /** Export records as JSON Lines. */
  exportJsonl(filter?: { sessionId?: string }): string {
    return this.#store
      .listTraces(filter)
      .map((r) => JSON.stringify(r))
      .join('\n');
  }
}
