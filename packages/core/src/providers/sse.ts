// Minimal Server-Sent Events parser (WHATWG event-stream format).
import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from 'node:stream/web';

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Parse an SSE byte stream into events. Handles chunk boundaries, CRLF,
 * comment lines and multi-line data fields.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  opts: { idleTimeoutMs?: number; signal?: AbortSignal } = {},
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  // Cancellation: the caller's signal also aborts the fetch, which errors this
  // stream; we do not cancel the reader from the abort listener as well.
  // (Cancelling from both sides at once, plus releaseLock(), crashed Node 24 on
  // Windows with 0xC0000409 in stress tests.)
  let finished = false;
  try {
    for (;;) {
      if (opts.signal?.aborted) break;
      const { value, done } = await readWithIdle(reader, opts.idleTimeoutMs);
      if (done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = nextLineEnd(buffer)) >= 0) {
        let line = buffer.slice(0, idx);
        // consume \r\n, \n or \r
        const skip = buffer[idx] === '\r' && buffer[idx + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(idx + skip);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data.length > 0) yield { event: event || 'message', data: data.join('\n') };
          event = '';
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let val = colon < 0 ? '' : line.slice(colon + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '' && buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
    if (data.length > 0) yield { event: event || 'message', data: data.join('\n') };
  } finally {
    // Stopped early (consumer returned, abort, error): release the body.
    if (!finished) await reader.cancel().catch(() => {});
  }
  if (opts.signal?.aborted) {
    const reason: unknown = opts.signal.reason;
    throw reason instanceof Error ? reason : Object.assign(new Error('aborted'), { name: 'AbortError' });
  }
}

function nextLineEnd(s: string): number {
  const n = s.indexOf('\n');
  const r = s.indexOf('\r');
  if (r >= 0 && r === s.length - 1) return n >= 0 && n < r ? n : -1; // a lone trailing \r may be half of \r\n
  if (n < 0) return r;
  if (r < 0) return n;
  return Math.min(n, r);
}

async function readWithIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!idleMs) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(Object.assign(new Error(`stream idle for ${idleMs} ms`), { name: 'StreamIdleError' }));
    }, idleMs);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
