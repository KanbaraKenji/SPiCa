// Event bus. The UI and the MCP server consume only these typed events
// (definitions live in @spica/protocol).
import type { CoreEvent, CoreEventBody } from '@spica/protocol';

export type { CoreEvent, CoreEventBody, CoreEventType, EventBase, RunEndReason } from '@spica/protocol';

export type EventListener = (event: CoreEvent) => void;

/** Fan-out bus. Listener errors never break the agent loop. */
export class EventBus {
  #seq = 0;
  #listeners = new Set<EventListener>();

  on(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(base: { sessionId: string; parentChain: string[] }, body: CoreEventBody): CoreEvent {
    const event = { ...body, seq: ++this.#seq, at: isoNow(), sessionId: base.sessionId, parentChain: base.parentChain } as CoreEvent;
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A broken consumer must not stop the agent.
      }
    }
    return event;
  }

  /** Async iterator over events (optionally filtered). Ends when `signal` aborts. */
  async *stream(filter?: (e: CoreEvent) => boolean, signal?: AbortSignal): AsyncGenerator<CoreEvent> {
    const queue: CoreEvent[] = [];
    let wake: (() => void) | undefined;
    const off = this.on((e) => {
      if (!filter || filter(e)) {
        queue.push(e);
        wake?.();
      }
    });
    const onAbort = () => wake?.();
    signal?.addEventListener('abort', onAbort);
    try {
      while (!signal?.aborted) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
    } finally {
      off();
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** ISO 8601 timestamp in local time with numeric offset, e.g. 2026-11-09T15:20:01.123+08:00. */
export function isoNow(date: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}
