import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { anthropicProvider, startGateway } from '../testing/helpers.ts';
import type { Message } from '../types.ts';
import { AnthropicProvider, toAnthropicMessages } from './anthropic.ts';
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

function msg(role: 'user' | 'assistant', content: Message['content']): Message {
  return { id: 'm', sessionId: 's', seq: 1, role, kind: role === 'user' ? 'user' : 'assistant', content, createdAt: '' };
}

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'claude-test',
  system: 'sys',
  messages: [msg('user', [{ type: 'text', text: 'hi' }])],
  tools: [{ name: 'read_file', description: 'd', inputSchema: { type: 'object' } }],
  maxTokens: 100,
  ...over,
});

async function run(p: AnthropicProvider, r: ModelRequest) {
  const events: ProviderEvent[] = [];
  for await (const e of p.stream(r, { signal: new AbortController().signal })) events.push(e);
  return { events, response: events.find((e) => e.type === 'response')!.response };
}

describe('AnthropicProvider', () => {
  it('parses thinking (with signature), text and tool_use with streamed JSON input', async () => {
    gw.enqueue({
      reasoning: ['hmm ', 'ok'],
      text: ['Look', 'ing'],
      toolCalls: [{ id: 'tu1', name: 'read_file', args: { path: 'notes.txt' } }],
      usage: { input: 50, output: 9, cacheRead: 40 },
    });
    const { response, events } = await run(anthropicProvider(gw), req());
    expect(response.content).toEqual([
      { type: 'thinking', text: 'hmm ok', signature: 'sig-fake', provider: 'fake-anthropic' },
      { type: 'text', text: 'Looking' },
      { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'notes.txt' } },
    ]);
    expect(response.stopReason).toBe('tool_use');
    expect(response.usage).toEqual({ inputTokens: 50, outputTokens: 9, cacheReadTokens: 40 });
    expect(events.filter((e) => e.type === 'thinking')).toHaveLength(2);
  });

  it('sends version header, key, cache_control on system/tools/last message', async () => {
    gw.enqueue({ text: 'ok' });
    await run(anthropicProvider(gw), req());
    const r = gw.requests[0]!;
    expect(r.headers['anthropic-version']).toBe('2023-06-01');
    expect(r.headers['x-api-key']).toBe('test-key-123456');
    expect(r.body.max_tokens).toBe(100);
    expect(r.body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    const tools = r.body.tools as Record<string, unknown>[];
    expect(tools[tools.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
    const messages = r.body.messages as { content: Record<string, unknown>[] }[];
    expect(messages[0]!.content[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('adds the hosted web search tool only when requested and enabled', async () => {
    gw.enqueue({ text: 'a' }, { text: 'b' });
    await run(anthropicProvider(gw), req({ serverTools: [{ kind: 'web_search', maxUses: 3 }] }));
    const p2 = new AnthropicProvider({ id: 'x', baseUrl: `${gw.baseUrl}/v1`, apiKey: 'test-key-123456', webSearch: false });
    await run(p2, req({ serverTools: [{ kind: 'web_search' }] }));
    const t1 = gw.requests[0]!.body.tools as Record<string, unknown>[];
    const t2 = gw.requests[1]!.body.tools as Record<string, unknown>[];
    expect(t1.some((t) => t.name === 'web_search' && t.max_uses === 3)).toBe(true);
    expect(t2.some((t) => t.name === 'web_search')).toBe(false);
  });
});

describe('toAnthropicMessages', () => {
  it('merges same-role turns, puts tool results first, drops foreign thinking', () => {
    const out = toAnthropicMessages(
      [
        msg('user', [{ type: 'text', text: 'q' }]),
        msg('assistant', [
          { type: 'thinking', text: 'mine', signature: 's1', provider: 'a' },
          { type: 'thinking', text: 'other', signature: 's2', provider: 'b' },
          { type: 'tool_use', id: 't1', name: 'n', input: { a: 1 } },
        ]),
        msg('user', [{ type: 'text', text: 'steer' }]),
        msg('user', [{ type: 'tool_result', toolUseId: 't1', content: 'r', isError: true }]),
      ],
      'a',
    );
    expect(out).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'mine', signature: 's1' },
          { type: 'tool_use', id: 't1', name: 'n', input: { a: 1 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'r', is_error: true },
          { type: 'text', text: 'steer' },
        ],
      },
    ]);
  });

  it('echoes opaque blocks to their own provider only', () => {
    const blocks: Message['content'] = [{ type: 'opaque', provider: 'a', data: { type: 'server_tool_use', id: 'x' }, text: '[search]' }];
    expect(toAnthropicMessages([msg('assistant', blocks)], 'a')[0]!.content).toEqual([{ type: 'server_tool_use', id: 'x' }]);
    expect(toAnthropicMessages([msg('assistant', blocks)], 'b')[0]!.content).toEqual([{ type: 'text', text: '[search]' }]);
  });
});
