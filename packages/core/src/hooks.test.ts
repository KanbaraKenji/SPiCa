// Plugin hooks: six injection positions, request/response rewriting,
// tool interception, and withdrawal by source.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { anthropicProvider, captureEvents, makeRuntime, startGateway } from './testing/helpers.ts';
import type { Tool } from './tools/types.ts';
import { DATA_RULE } from './guard.ts';
import { deliveryRule, languageLine, TEAM_RULE } from './session.ts';

// gateways, child processes and local servers start slowly when several full runs share the machine
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
beforeEach(async () => {
  gw = await startGateway();
});
afterEach(async () => {
  await gw.stop();
});

type OAMessage = { role: string; content: string | null; tool_call_id?: string };

const echoTool: Tool = {
  spec: { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  async execute(input) {
    return { content: `echo:${String(input.text)}` };
  },
};

describe('injection positions', () => {
  it('places content before/after system, history and input, in priority order', async () => {
    gw.enqueue({ text: 'first answer' }, { text: 'second answer' });
    const rt = makeRuntime(gw);
    rt.hooks.register('plugin-a', {
      inject: () => [
        { position: 'system:before', text: 'SYS-BEFORE' },
        { position: 'system:after', text: 'SYS-AFTER' },
        { position: 'history:before', text: 'HIST-BEFORE' },
        { position: 'history:after', text: 'HIST-AFTER' },
        { position: 'input:before', text: 'IN-BEFORE' },
        { position: 'input:after', text: 'IN-AFTER-2', priority: 200 },
      ],
    });
    rt.hooks.register('plugin-b', { inject: () => [{ position: 'input:after', text: 'IN-AFTER-1', priority: 50 }] });
    const s = rt.createSession({ system: 'BASE' });
    await s.send('question one').done;
    await s.send('question two').done;

    const msgs = gw.requests[1]!.body.messages as OAMessage[];
    expect(msgs[0]).toEqual({ role: 'system', content: `SYS-BEFORE\n\nBASE\n\n${DATA_RULE}\n\n${languageLine('zh-CN')}\n\n${deliveryRule({ cwd: process.cwd(), suggest: true })}\n\n${TEAM_RULE}\n\nSYS-AFTER` });
    const flat = msgs.slice(1).map((m) => m.content ?? '');
    const at = (needle: string) => flat.findIndex((c) => c.includes(needle));
    // history = [question one, first answer]; input = [question two]
    expect(at('HIST-BEFORE')).toBeLessThan(at('question one'));
    expect(at('question one')).toBeLessThan(at('first answer'));
    expect(at('first answer')).toBeLessThan(at('HIST-AFTER'));
    expect(at('HIST-AFTER')).toBeLessThan(at('IN-BEFORE'));
    expect(at('IN-BEFORE')).toBeLessThan(at('question two'));
    expect(at('question two')).toBeLessThan(at('IN-AFTER-1'));
    expect(at('IN-AFTER-1')).toBeLessThan(at('IN-AFTER-2'));
    expect(flat[at('IN-BEFORE')]).toContain('<context source="plugin-a">');

    // Injections are recomputed each turn and never stored in the session.
    expect(JSON.stringify(s.messages())).not.toContain('HIST-BEFORE');
  });

  it('keeps injections around the input when the run has tool turns', async () => {
    gw.enqueue({ toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'x' } }] }, { text: 'done' });
    const rt = makeRuntime(gw, { tools: [echoTool] });
    rt.hooks.register('p', { inject: () => [{ position: 'input:after', text: 'AFTER-INPUT' }] });
    const s = rt.createSession();
    await s.send('go').done;
    const msgs = gw.requests[1]!.body.messages as OAMessage[];
    const roles = msgs.map((m) => (m.content?.includes('AFTER-INPUT') ? 'inj' : m.role));
    expect(roles).toEqual(['system', 'user', 'inj', 'assistant', 'tool']);
  });
});

describe('request and response hooks', () => {
  it('beforeRequest can change tools, params and segments', async () => {
    gw.enqueue({ text: 'ok' });
    const rt = makeRuntime(gw, { tools: [echoTool] });
    rt.hooks.register('p', {
      beforeRequest: (draft) => ({
        ...draft,
        tools: [...draft.tools, { name: 'extra_tool', description: 'added by plugin', inputSchema: { type: 'object' } }],
        params: { ...draft.params, maxTokens: 77, temperature: 0.1, extra: { custom_flag: true } },
        segments: { ...draft.segments, system: { ...draft.segments.system, base: 'REWRITTEN' } },
      }),
    });
    await rt.createSession().send('hi').done;
    const body = gw.requests[0]!.body;
    expect(body.max_tokens).toBe(77);
    expect(body.temperature).toBe(0.1);
    expect(body.custom_flag).toBe(true);
    expect((body.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(['echo', 'extra_tool']);
    expect((body.messages as OAMessage[])[0]!.content).toBe('REWRITTEN');
  });

  it('afterResponse can rewrite text and tool calls; the UI gets message.replaced', async () => {
    gw.enqueue({ text: 'secret 1234', toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'a' } }] }, { text: 'end' });
    const rt = makeRuntime(gw, { tools: [echoTool] });
    const events = captureEvents(rt);
    rt.hooks.register('redactor', {
      afterResponse: (res) => ({
        ...res,
        content: res.content.map((b) =>
          b.type === 'text' ? { ...b, text: b.text.replace(/\d+/g, '####') } : b.type === 'tool_use' ? { ...b, input: { text: 'rewritten' } } : b,
        ),
      }),
    });
    const s = rt.createSession();
    await s.send('go').done;
    expect(s.messages()[1]!.content[0]).toEqual({ type: 'text', text: 'secret ####' });
    expect(JSON.stringify(s.messages()[2]!.content)).toContain('echo:rewritten');
    expect(events.some((e) => e.type === 'message.replaced')).toBe(true);
  });
});

describe('tool hooks', () => {
  it('beforeTool can deny or rewrite input; afterTool can rewrite the result', async () => {
    gw.enqueue(
      {
        toolCalls: [
          { id: 'a', name: 'echo', args: { text: 'blocked' } },
          { id: 'b', name: 'echo', args: { text: 'original' } },
        ],
      },
      { text: 'end' },
    );
    const rt = makeRuntime(gw, { tools: [echoTool] });
    rt.hooks.register('guard', {
      beforeTool: (call) => {
        const text = (call.input as { text: string }).text;
        if (text === 'blocked') return { action: 'deny', reason: 'policy says no' };
        return { action: 'allow', input: { text: `${text}+changed` } };
      },
      afterTool: (_call, result) => ({ ...result, content: `${result.content} (checked)` }),
    });
    const s = rt.createSession();
    await s.send('go').done;
    const results = s.messages()[2]!.content;
    expect(results[0]).toMatchObject({ isError: true });
    expect(JSON.stringify(results[0])).toContain('policy says no');
    expect(JSON.stringify(results[1])).toContain('echo:original+changed (checked)');
  });

  it('unregisterSource withdraws hooks and tools of that plugin only', async () => {
    gw.onRequest(() => ({ text: 'ok' }));
    const rt = makeRuntime(gw);
    rt.tools.register({ ...echoTool, spec: { ...echoTool.spec, name: 'plugin_tool' } }, 'my-plugin');
    rt.hooks.register('my-plugin', { inject: () => [{ position: 'system:after', text: 'PLUGIN-ON' }] });
    rt.hooks.register('other', { inject: () => [{ position: 'system:after', text: 'OTHER-ON' }] });
    const s = rt.createSession();
    await s.send('one').done;
    expect(JSON.stringify(gw.requests[0]!.body)).toContain('PLUGIN-ON');
    expect(JSON.stringify(gw.requests[0]!.body.tools)).toContain('plugin_tool');

    expect(rt.unregisterSource('my-plugin')).toMatchObject({ hooks: 1, tools: 1, mcpServers: 0 });
    await s.send('two').done;
    const body = JSON.stringify(gw.requests[1]!.body);
    expect(body).not.toContain('PLUGIN-ON');
    expect(body).not.toContain('plugin_tool');
    expect(body).toContain('OTHER-ON');
  });

  it('hooks see the same draft shape with the Anthropic provider', async () => {
    gw.enqueue({ text: 'ok' });
    const rt = makeRuntime(gw, {
      providers: [anthropicProvider(gw)],
      defaults: { providerId: 'fake-anthropic', model: 'claude-haiku-5-5', maxTokens: 64 },
    });
    rt.hooks.register('p', { inject: () => [{ position: 'system:before', text: 'PRE' }] });
    await rt.createSession({ system: 'BASE' }).send('hi').done;
    expect(gw.requests[0]!.body.system).toEqual([{ type: 'text', text: `PRE\n\nBASE\n\n${DATA_RULE}\n\n${languageLine('zh-CN')}\n\n${deliveryRule({ cwd: process.cwd(), suggest: true })}\n\n${TEAM_RULE}`, cache_control: { type: 'ephemeral' } }]);
  });
});
