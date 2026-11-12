// Traceable records: one per external request (model, search, fetch, MCP, auth).
import type { TraceKind, TraceRecord } from './types.ts';
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
    | 'model'
  >
> & { status: TraceRecord['status'] };

export interface TraceHandle {
  readonly id: string;
  finish(result: TraceFinish): TraceRecord;
}

export class Tracer {
  readonly #store: Store;
  readonly #bus: EventBus | undefined;

  readonly #scrub: (text: string) => string;

  /** `scrub` removes known secrets from error texts (default: pattern-based redaction only). */
  constructor(store: Store, bus?: EventBus, scrub: (text: string) => string = (t) => redact(t)) {
    this.#store = store;
    this.#bus = bus;
    this.#scrub = scrub;
  }

  start(start: TraceStart): TraceHandle {
    const id = newId('tr');
    const startedAt = isoNow();
    const t0 = performance.now();
    let done = false;
    return {
      id,
      finish: (result) => {
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
