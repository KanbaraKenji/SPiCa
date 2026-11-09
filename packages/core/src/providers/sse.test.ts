import { describe, expect, it } from 'vitest';
import { parseSse } from './sse.ts';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctl) {
      for (const c of chunks) ctl.enqueue(enc.encode(c));
      ctl.close();
    },
  });
}

async function collect(chunks: string[]) {
  const out = [];
  for await (const e of parseSse(streamOf(chunks))) out.push(e);
  return out;
}

describe('parseSse', () => {
  it('parses events split across arbitrary chunk boundaries', async () => {
    const text = 'event: a\ndata: {"x":1}\n\ndata: second\n\n';
    const chunks = text.split('').map((c) => c); // one byte at a time
    expect(await collect(chunks)).toEqual([
      { event: 'a', data: '{"x":1}' },
      { event: 'message', data: 'second' },
    ]);
  });

  it('handles CRLF, comments and multi-line data', async () => {
    const events = await collect([': keep-alive\r\n', 'data: line1\r\ndata: line2\r\n\r', '\n', 'data: [DONE]\r\n\r\n']);
    expect(events).toEqual([
      { event: 'message', data: 'line1\nline2' },
      { event: 'message', data: '[DONE]' },
    ]);
  });

  it('flushes a final event without a trailing blank line', async () => {
    expect(await collect(['data: tail'])).toEqual([{ event: 'message', data: 'tail' }]);
  });

  it('multi-byte characters split across chunks are decoded correctly', async () => {
    const bytes = new TextEncoder().encode('data: 你好\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(bytes.slice(0, 8));
        ctl.enqueue(bytes.slice(8));
        ctl.close();
      },
    });
    const out = [];
    for await (const e of parseSse(stream)) out.push(e);
    expect(out).toEqual([{ event: 'message', data: '你好' }]);
  });
});
