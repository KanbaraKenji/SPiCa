import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { FAST_RETRY, openaiProvider, startGateway } from '../testing/helpers.ts';
import type { Message } from '../types.ts';
import { OpenAICompatibleProvider, toOpenAIMessages } from './openai.ts';
import type { ModelRequest, ProviderEvent } from './types.ts';

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
