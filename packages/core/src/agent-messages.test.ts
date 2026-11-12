// Agents messaging each other with nobody watching: at most defaults.agentMessages message_agent calls per
// conversation since the user last wrote in it (the desktop app gives 10; others give none).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MESSAGES_LIMIT_MARK } from '@spica/protocol';
import { sentSinceUserWrote } from './tools/agent-tools.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway } from './testing/helpers.ts';
import type { Message } from './types.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const msg = (over: Partial<Message>): Message => ({ id: 'm', sessionId: 's', seq: 1, role: 'user', kind: 'user', content: [], createdAt: '', ...over });
const call = (id: string): Message => msg({ role: 'assistant', kind: 'assistant', content: [{ type: 'tool_use', id, name: 'message_agent', input: {} }] });

describe('counting since the user last wrote', () => {
  it('message_agent calls after the last message the user typed; a parent’s message does not start it over', () => {
    expect(sentSinceUserWrote([call('a'), msg({}), call('b'), call('c'), call('now')], 'now')).toBe(2);
    expect(sentSinceUserWrote([msg({}), call('a'), msg({ meta: { author: 'parent' } }), call('b')], 'x')).toBe(2);
    expect(sentSinceUserWrote([call('a'), msg({ kind: 'steer' }), call('b')], 'x')).toBe(1);
    expect(sentSinceUserWrote([call('a'), call('b')], 'x')).toBe(2); // nothing typed yet (a sub-agent): all of them
  });
});

describe('message_agent refuses past the limit', () => {
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = await startGateway();
  });
  afterEach(async () => {
    await gw.stop();
  });

  /** The top conversation keeps messaging its sub-agent; the sub-agent just answers. */
  async function setup(agentMessages?: number) {
    const rt = makeRuntime(gw, { defaults: { providerId: 'fake-openai', model: 'fake-model', maxTokens: 512, ...(agentMessages !== undefined ? { agentMessages } : {}) } });
    const top = rt.createSession();
    const child = rt.createSession({ parentId: top.id, title: 'helper' });
    let calls = 0;
    gw.onRequest((req) => {
      const body = JSON.stringify(req.body);
      if (!body.includes('keep asking')) return { text: 'ok' };
      // told to stop since the user last asked: it stops
      if (body.lastIndexOf(AGENT_MESSAGES_LIMIT_MARK) > body.lastIndexOf('keep asking') || ++calls > 6) return { text: 'stopping' };
      return { toolCalls: [{ name: 'message_agent', args: { id: child.id, text: `ping ${calls}` } }] };
    });
    return { rt, top, child };
  }

  const results = (s: { messages(): Message[] }) =>
    s.messages().flatMap((m) => m.content).filter((b): b is Extract<Message['content'][number], { type: 'tool_result' }> => b.type === 'tool_result');

  it('the third message with a limit of 2 is not sent; the model is told why; the user writing starts the count over', async () => {
    const { top, child } = await setup(2);
    await top.send('keep asking').done;
    const r = results(top);
    expect(r.slice(0, 2).every((x) => !x.isError)).toBe(true);
    expect(r[2]).toMatchObject({ isError: true });
    expect(r[2]!.content).toContain(AGENT_MESSAGES_LIMIT_MARK);
    expect(r[2]!.content).toMatch(/the count starts over when the user writes/);
    expect(child.messages().filter((m) => m.meta?.author === 'parent').length).toBe(2);
    await top.send('keep asking, again').done;
    expect(child.messages().filter((m) => m.meta?.author === 'parent').length).toBe(4);
  });

  it('no limit given (scripts, the MCP service) or 0: as before', async () => {
    for (const n of [undefined, 0]) {
      const { top } = await setup(n);
      await top.send('keep asking').done;
      expect(results(top).filter((x) => x.isError)).toEqual([]);
      expect(results(top).length).toBe(6);
    }
  });

  it('a change of the setting applies at the next call', async () => {
    const { rt, top } = await setup(0);
    rt.setDefaults({ agentMessages: 1 });
    await top.send('keep asking').done;
    expect(results(top).filter((x) => x.isError).length).toBe(1);
  });
});
