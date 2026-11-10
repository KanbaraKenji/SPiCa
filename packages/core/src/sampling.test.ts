// Plugins use the user's models through MCP sampling: only when granted, no
// tools, no conversation, within a daily limit, recorded without the text.
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Runtime } from './runtime.ts';
import { MemoryStore } from './store/memory.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway } from './testing/helpers.ts';

const script = fileURLToPath(new URL('./testing/fake-mcp-server.mjs', import.meta.url));

let gw: FakeGateway;
const runtimes: Runtime[] = [];
beforeEach(async () => {
  gw = await startGateway();
  gw.onRequest(() => ({ text: 'a short answer', usage: { input: 40, output: 5 } }));
});
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.close();
  await gw.stop();
});

function runtime(opts: Parameters<typeof makeRuntime>[1] = {}) {
  const rt = makeRuntime(gw, opts);
  runtimes.push(rt);
  return rt;
}

/** Connect the fake server as the "notes" plugin's server; its `ask` tool makes it send sampling/createMessage. */
async function plugin(rt: Runtime, grant?: { pluginId: string; maxUsdPerDay?: number }) {
  const h = await rt.connectMcp(
    { name: 'notes', command: process.execPath, args: [script], env: { FAKE_MCP_SAMPLING: '1' }, ...(grant ? { sampling: grant } : {}) },
    { source: 'plugin:notes' },
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await rt.tools.get(`notes__${name}`)!.execute(args, ctx(rt));
    return JSON.parse(r.content) as Record<string, unknown>;
  };
  return { call, close: () => h.disconnect() };
}

const ctx = (rt: Runtime) => ({ sessionId: '', parentChain: [], cwd: '.', signal: new AbortController().signal, tracer: rt.tracer, extractors: [], services: {}, callId: 'c', emit: () => {} });
const ask = (params: Record<string, unknown>) => ({ params: { messages: [{ role: 'user', content: { type: 'text', text: 'Summarize: the meeting moved to Friday.' } }], maxTokens: 100, ...params } });

describe('plugins using the user models (MCP sampling)', () => {
  it('only a granted server is offered sampling; it gets a plain answer, no tools, nothing of any conversation, within the default model limits', async () => {
    const rt = runtime();
    const notGranted = await plugin(rt);
    expect(await notGranted.call('caps')).toEqual({});
    expect(await notGranted.call('ask', ask({}))).toMatchObject({ error: { code: -32601 } });
    await notGranted.close();

    const granted = await plugin(rt, { pluginId: 'notes' });
    expect(await granted.call('caps')).toEqual({ sampling: {} });
    const r = await granted.call('ask', ask({ systemPrompt: 'You summarize notes.', maxTokens: 100_000 }));
    expect(r).toEqual({ result: { role: 'assistant', content: { type: 'text', text: 'a short answer' }, model: 'fake-model', stopReason: 'endTurn' } });
    const body = gw.requests.at(-1)!.body;
    expect(body.tools).toBeUndefined();
    expect((body.messages as { role: string; content: string }[])[0]).toEqual({ role: 'system', content: 'You summarize notes.' }); // no app rules, no history
    expect(Number(body.max_tokens ?? body.max_completion_tokens)).toBeLessThanOrEqual(512); // the app's limit
    expect(rt.sessions()).toEqual([]);

    // recorded: who, model, tokens, cost; never the text
    const traces = rt.exportTraces();
    expect(traces).toContain('"initiator":"plugin:notes"');
    expect(traces).not.toContain('meeting moved');
    expect(traces).not.toContain('a short answer');
    expect(rt.sampler.spentToday('notes')).toBeGreaterThan(0);
    expect(rt.ledger.globalUsd).toBeCloseTo(rt.sampler.spentToday('notes'));
    await granted.close();
  });

  it('which model: strong when asked and configured; a named one that is not configured falls back and says so, or is refused when required', async () => {
    const rt = runtime({ defaults: { providerId: 'fake-openai', model: 'fake-model', maxTokens: 512, strongModel: 'big-model' } });
    const c = await plugin(rt, { pluginId: 'notes' });
    expect(await c.call('ask', ask({ modelPreferences: { intelligencePriority: 0.9 } }))).toMatchObject({ result: { model: 'big-model' } });
    expect(gw.requests.at(-1)!.body.model).toBe('big-model');
    expect(await c.call('ask', ask({ modelPreferences: { hints: [{ name: 'big' }] } }))).toMatchObject({ result: { model: 'big-model' } });
    const fell = await c.call('ask', ask({ modelPreferences: { hints: [{ name: 'claude-sonnet' }] } }));
    expect(fell).toMatchObject({ result: { model: 'fake-model', _meta: { spica: { fallback: true, requested: 'claude-sonnet' } } } });
    const strict = await c.call('ask', ask({ modelPreferences: { hints: [{ name: 'claude-sonnet' }] }, _meta: { spica: { requireModel: true } } }));
    expect(strict).toMatchObject({ error: { code: -32000, data: { code: 'model_not_configured' } } });
    await c.close();
  });

  it('refusals the plugin can tell apart: daily limit, tools, non-text, no model at all; the day total survives a restart', async () => {
    const store = new MemoryStore();
    const rt = runtime({ store });
    const c = await plugin(rt, { pluginId: 'notes', maxUsdPerDay: 0.05 });
    expect(await c.call('ask', ask({}))).toHaveProperty('result');
    const spent = rt.sampler.spentToday('notes');
    const n = gw.requests.length;
    expect(await c.call('ask', ask({ tools: [{ name: 'x' }] }))).toMatchObject({ error: { data: { code: 'invalid' } } });
    expect(await c.call('ask', { params: { messages: [{ role: 'user', content: { type: 'image', data: 'x', mimeType: 'image/png' } }], maxTokens: 10 } })).toMatchObject({ error: { data: { code: 'invalid' } } });
    await c.close();

    const tight = await plugin(rt, { pluginId: 'notes', maxUsdPerDay: spent });
    const over = await tight.call('ask', ask({}));
    expect(over).toMatchObject({ error: { data: { code: 'budget' } } });
    expect(String((over.error as { message: string }).message)).toMatch(/budget for today is used up/);
    expect(gw.requests.length).toBe(n); // nothing was sent
    await tight.close();

    const after = runtime({ store });
    expect(after.sampler.spentToday('notes')).toBeCloseTo(spent);

    const none = runtime({ providers: [], defaults: { providerId: '', model: '', maxTokens: 64 } });
    const c2 = await plugin(none, { pluginId: 'notes' });
    expect(await c2.call('ask', ask({}))).toMatchObject({ error: { data: { code: 'no_model' } } });
    await c2.close();
  });
});
