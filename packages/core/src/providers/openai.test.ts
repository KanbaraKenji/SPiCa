import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { FAST_RETRY, openaiProvider, startGateway } from '../testing/helpers.ts';
import type { Message } from '../types.ts';
import { OpenAICompatibleProvider, toOpenAIMessages } from './openai.ts';
import type { ModelRequest, ProviderEvent } from './types.ts';

// gateways, child processes and local servers start slowly when several full runs share the machine
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
beforeEach(async () => {
  gw = await startGateway({ apiKey: 'test-key-123456' });
});
afterEach(async () => {
  await gw.stop();
});

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'fake-model',
  system: 'sys',
  messages: [msg('user', [{ type: 'text', text: 'hi' }])],
  tools: [],
  maxTokens: 100,
  ...over,
});

function msg(role: 'user' | 'assistant', content: Message['content'], kind: Message['kind'] = role === 'user' ? 'user' : 'assistant'): Message {
  return { id: 'm', sessionId: 's', seq: 1, role, kind, content, createdAt: '' };
}

async function run(p: OpenAICompatibleProvider, r: ModelRequest, signal = new AbortController().signal) {
  const events: ProviderEvent[] = [];
  const info = { attempts: 0 };
  for await (const e of p.stream(r, { signal, info })) events.push(e);
  return { events, info, response: events.find((e) => e.type === 'response')!.response };
}

describe('OpenAICompatibleProvider', () => {
  it('streams text deltas and parses usage', async () => {
    gw.enqueue({ text: ['Hel', 'lo'], usage: { input: 12, output: 3, cacheRead: 4 } });
    const { events, response } = await run(openaiProvider(gw), req());
    expect(events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.delta : ''))).toEqual(['Hel', 'lo']);
    expect(response.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 3, cacheReadTokens: 4 });
    expect(response.stopReason).toBe('end');
    const body = gw.requests[0]!.body;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(100);
    expect(gw.requests[0]!.headers.authorization).toBe('Bearer test-key-123456');
  });

  it('merges tool_call fragments by index', async () => {
    gw.enqueue({ toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }, { id: 'c2', name: 'grep', args: { pattern: 'x' } }] });
    const { response, events } = await run(openaiProvider(gw), req());
    expect(response.stopReason).toBe('tool_use');
    expect(response.content).toEqual([
      { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.txt' } },
      { type: 'tool_use', id: 'c2', name: 'grep', input: { pattern: 'x' } },
    ]);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(2);
  });

  it('keeps invalid tool arguments visible instead of throwing', async () => {
    gw.enqueue({ toolCalls: [{ id: 'c1', name: 'read_file', args: '{"path": ' }] });
    const { response } = await run(openaiProvider(gw), req());
    expect(response.content[0]).toMatchObject({ type: 'tool_use', input: { __invalid_json__: '{"path": ' } });
  });

  it('parses reasoning deltas into a thinking block', async () => {
    gw.enqueue({ reasoning: ['think ', 'more'], text: 'answer' });
    const { response } = await run(openaiProvider(gw), req());
    expect(response.content[0]).toEqual({ type: 'thinking', text: 'think more', provider: 'fake-openai' });
  });

  it('retries 429 and 5xx, then succeeds', async () => {
    gw.enqueue({ status: 429, headers: { 'retry-after': '0' } }, { status: 503 }, { text: 'ok' });
    const { response, info } = await run(openaiProvider(gw), req());
    expect(response.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(info.attempts).toBe(3);
  });

  it('does not retry 400 and redacts the key from the error', async () => {
    gw.enqueue({ status: 400, errorBody: 'bad request for key test-key-123456' });
    await expect(run(openaiProvider(gw), req())).rejects.toThrow(/HTTP 400.*\[redacted\]/);
    expect(gw.requests).toHaveLength(1);
  });

  it('gives up after maxAttempts', async () => {
    gw.enqueue({ status: 500 }, { status: 500 }, { status: 500 }, { text: 'never' });
    await expect(run(openaiProvider(gw), req())).rejects.toThrow(/HTTP 500/);
    expect(gw.requests).toHaveLength(FAST_RETRY.maxAttempts);
  });

  it('aborts a hanging stream', async () => {
    gw.enqueue({ text: ['a', 'b'], hangAfterChunks: 1 });
    const ac = new AbortController();
    const p = run(openaiProvider(gw), req(), ac.signal);
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toThrow();
  });

  it('records the provider id as trace target unless traceHost is set', () => {
    expect(openaiProvider(gw).traceTarget).toBe('fake-openai');
    const withHost = new OpenAICompatibleProvider({ id: 'x', baseUrl: `${gw.baseUrl}/v1`, traceHost: true });
    expect(withHost.traceTarget).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it('sends tools as functions and the max-tokens field name can be changed', async () => {
    const p = new OpenAICompatibleProvider({ id: 'x', baseUrl: `${gw.baseUrl}/v1`, apiKey: 'test-key-123456', maxTokensField: 'max_completion_tokens' });
    gw.enqueue({ text: 'ok' });
    await run(p, req({ tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }] }));
    const body = gw.requests[0]!.body;
    expect(body.max_completion_tokens).toBe(100);
    expect(body.tools).toEqual([{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }]);
  });
});

describe('toOpenAIMessages', () => {
  it('maps tool results to role=tool before user text, and echoes own reasoning on tool turns', () => {
    const out = toOpenAIMessages(
      'sys',
      [
        msg('user', [{ type: 'text', text: 'q' }]),
        msg('assistant', [
          { type: 'thinking', text: 'mine', provider: 'p1' },
          { type: 'thinking', text: 'foreign', provider: 'p2' },
          { type: 'text', text: 'let me look' },
          { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a' } },
        ]),
        msg('user', [{ type: 'tool_result', toolUseId: 'c1', content: 'data' }, { type: 'text', text: 'steer' }], 'tool_results'),
      ],
      'p1',
      'reasoning_content',
      'tool_turns',
    );
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'let me look',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
        reasoning_content: 'mine',
      },
      { role: 'tool', tool_call_id: 'c1', content: 'data' },
      { role: 'user', content: 'steer' },
    ]);
  });

  it('does not echo reasoning when echo=never', () => {
    const out = toOpenAIMessages(
      '',
      [msg('assistant', [{ type: 'thinking', text: 'r', provider: 'p1' }, { type: 'tool_use', id: 'c', name: 'n', input: {} }])],
      'p1',
      'reasoning_content',
      'never',
    );
    expect(out[0]).not.toHaveProperty('reasoning_content');
  });
});

describe('gateways that do not stream, or cut the stream', () => {
  const completion = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ id: 'c', model: 'gw-model', choices: [{ index: 0, message: { role: 'assistant', content: 'whole answer', ...over }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } });

  it('a complete JSON answer (stream ignored) is read as the answer, tool calls included, not as an empty stream', async () => {
    gw.enqueue({ json: completion() });
    const { events, response } = await run(openaiProvider(gw), req());
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'whole answer' }]);
    expect(response).toMatchObject({ content: [{ type: 'text', text: 'whole answer' }], stopReason: 'end', usage: { inputTokens: 7, outputTokens: 2 }, model: 'gw-model' });
    gw.enqueue({ json: completion({ content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] }) });
    const tools = await run(openaiProvider(gw), req());
    expect(tools.response).toMatchObject({ content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.txt' } }], stopReason: 'tool_use' });
    gw.enqueue({ json: '{"unexpected":true}' });
    await expect(run(openaiProvider(gw), req())).rejects.toMatchObject({ code: 'gateway.bad_response' });
  });

  it('a gateway that refuses stream: true with a 400 is asked again without streaming, and from then on', async () => {
    gw.onRequest((r) => (r.body.stream ? { status: 400, errorBody: '{"error":{"message":"stream is not supported"}}' } : { json: completion() }));
    const p = openaiProvider(gw);
    expect((await run(p, req())).response.content).toEqual([{ type: 'text', text: 'whole answer' }]);
    expect(gw.requests.map((r) => r.body.stream)).toEqual([true, false]);
    expect(gw.requests[1]!.body).not.toHaveProperty('stream_options');
    await run(p, req());
    expect(gw.requests.map((r) => r.body.stream)).toEqual([true, false, false]); // remembered
    // another 400 is not taken for this
    gw.onRequest(() => ({ status: 400, errorBody: '{"error":{"message":"model not found"}}' }));
    await expect(run(openaiProvider(gw), req())).rejects.toMatchObject({ status: 400 });
  });

  it('step 1: a gateway that only refuses stream_options still streams, without that field from then on', async () => {
    const strict = await startGateway({ apiKey: 'test-key-123456', rejectStreamOptions: true });
    try {
      strict.onRequest(() => ({ text: ['still ', 'streaming'] }));
      const p = new OpenAICompatibleProvider({ id: 'x', baseUrl: `${strict.baseUrl}/v1`, apiKey: 'test-key-123456', retry: FAST_RETRY });
      const first = await run(p, req());
      expect(first.events.filter((e) => e.type === 'text').length).toBe(2); // streamed, not one block
      expect(first.response.content).toEqual([{ type: 'text', text: 'still streaming' }]);
      expect(strict.requests.map((r) => [r.body.stream, 'stream_options' in r.body])).toEqual([[true, true], [true, false]]); // refused with it, streamed without
      await run(p, req());
      expect(strict.requests.map((r) => [r.body.stream, 'stream_options' in r.body])).toEqual([[true, true], [true, false], [true, false]]); // remembered
    } finally {
      await strict.stop();
    }
  });

  it('step 2: refused again for streaming itself once stream_options is gone: asked without streaming, and from then on', async () => {
    gw.onRequest((r) =>
      'stream_options' in r.body
        ? { status: 400, errorBody: '{"error":{"message":"Unrecognized request argument supplied: stream_options"}}' }
        : r.body.stream
          ? { status: 400, errorBody: '{"error":{"message":"streaming is not supported"}}' }
          : { json: completion() },
    );
    const p = openaiProvider(gw);
    expect((await run(p, req())).response.content).toEqual([{ type: 'text', text: 'whole answer' }]);
    expect(gw.requests.map((r) => [r.body.stream, 'stream_options' in r.body])).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
    await run(p, req());
    expect(gw.requests.at(-1)!.body.stream).toBe(false); // straight to not streaming
    expect(gw.requests).toHaveLength(4);
  });

  it('a stream that breaks off or goes quiet ends with a coded error, not a bare "terminated"', async () => {
    const { createServer } = await import('node:http');
    const { listenFetchable } = await import('../net.ts');
    const s = createServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"par"}}]}\n\n');
      setTimeout(() => res.destroy(), 30);
    });
    const port = await listenFetchable(s);
    try {
      const cut = new OpenAICompatibleProvider({ id: 'x', baseUrl: `http://127.0.0.1:${port}/v1`, retry: FAST_RETRY });
      await expect(run(cut, req())).rejects.toMatchObject({ name: 'ProviderError', code: 'net.reset' });
    } finally {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    gw.enqueue({ text: ['a', 'b'], hangAfterChunks: 1 });
    const quiet = new OpenAICompatibleProvider({ id: 'x', baseUrl: `${gw.baseUrl}/v1`, apiKey: 'test-key-123456', idleTimeoutMs: 150, retry: FAST_RETRY });
    await expect(run(quiet, req())).rejects.toMatchObject({ code: 'gateway.stream_idle' });
  });
});
