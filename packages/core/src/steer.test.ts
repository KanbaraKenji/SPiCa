// Mid-run user messages: "next" (turn boundary) and "interrupt" (abort → insert → continue).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, until } from './testing/helpers.ts';
import type { Tool } from './tools/types.ts';
import type { Message } from './types.ts';

let gw: FakeGateway;
beforeEach(async () => {
  gw = await startGateway();
});
afterEach(async () => {
  await gw.stop();
});

/** A tool that waits until released (or aborted). */
function gateTool(): { tool: Tool; started: () => boolean; release: () => void } {
  let release!: () => void;
  let started = false;
  const gate = new Promise<void>((r) => (release = r));
  return {
    started: () => started,
    release: () => release(),
    tool: {
      spec: { name: 'slow', description: 'slow', inputSchema: { type: 'object' } },
      async execute(_input, ctx) {
        started = true;
        await Promise.race([gate, new Promise<void>((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted'))))]);
        return { content: 'slow done' };
      },
    },
  };
}

const textOf = (m: Message) => m.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? `<result:${b.toolUseId}>` : b.type === 'tool_use' ? `<call:${b.id}>` : '')).join('');
const userTexts = (body: Record<string, unknown>) =>
  (body.messages as { role: string; content: string | null }[]).filter((m) => m.role === 'user').map((m) => m.content);

describe('steer: next turn boundary', () => {
  it('applies messages after the current tool batch, in order, none lost', async () => {
    const g = gateTool();
    gw.enqueue({ toolCalls: [{ id: 't1', name: 'slow', args: {} }] }, { text: 'final' });
    const rt = makeRuntime(gw, { tools: [g.tool] });
    const events = captureEvents(rt);
    const s = rt.createSession();
    const run = s.send('start').done;
    await until(g.started);
    const h1 = s.steer('also check A', 'next');
    const h2 = s.steer('and B', 'next');
    const h3 = s.send('and C'); // send during a run behaves like steer(next)
    expect([h1.started, h2.started, h3.started]).toEqual([false, false, false]);
    g.release();
    const r = await run;
    expect(r.reason).toBe('completed');
    expect(await h3.done).toEqual(r);

    expect(s.messages().map((m) => `${m.kind}:${textOf(m)}`)).toEqual([
      'user:start',
      'assistant:<call:t1>',
      'tool_results:<result:t1>',
      'steer:also check A',
      'steer:and B',
      'steer:and C',
      'assistant:final',
    ]);
    // The second model request saw all three, after the tool result.
    expect(userTexts(gw.requests[1]!.body)).toEqual(['start', 'also check A', 'and B', 'and C']);
    const applied = events.find((e) => e.type === 'steer.applied');
    expect(applied && applied.type === 'steer.applied' && applied.messageIds).toEqual([h1.messageId, h2.messageId, h3.messageId]);
  });

  it('a steer that arrives during the last model call still gets a turn', async () => {
    gw.enqueue({ text: ['partial ', 'answer'], chunkDelayMs: 30 }, { text: 'answer to the steer' });
    const rt = makeRuntime(gw);
    const s = rt.createSession();
    const run = s.send('q').done;
    await until(() => gw.requests.length === 1);
    s.steer('one more thing', 'next');
    const r = await run;
    expect(r.text).toBe('answer to the steer');
    expect(s.messages().map((m) => m.kind)).toEqual(['user', 'assistant', 'steer', 'assistant']);
  });
});

describe('steer: interrupt', () => {
  it('cuts the model stream, keeps the partial text, inserts the message and continues', async () => {
    gw.enqueue({ text: ['I will write a long', ' essay about'], hangAfterChunks: 1 }, { text: 'Okay, short version.' });
    const rt = makeRuntime(gw);
    const events = captureEvents(rt);
    const s = rt.createSession();
    const run = s.send('write an essay').done;
    await until(() => events.some((e) => e.type === 'text.delta'));
    s.steer('stop, make it short', 'interrupt');
    const r = await run;
    expect(r).toMatchObject({ reason: 'completed', text: 'Okay, short version.' });
    const msgs = s.messages();
    expect(msgs.map((m) => `${m.kind}:${textOf(m)}`)).toEqual([
      'user:write an essay',
      'assistant:I will write a long',
      'steer:stop, make it short',
      'assistant:Okay, short version.',
    ]);
    expect(msgs[1]!.meta?.interrupted).toBe(true);
    expect(gw.requests).toHaveLength(2);
    expect(rt.store.listTraces().map((t) => t.status)).toEqual(['aborted', 'ok']);
    // The aborted first stream is closed on the gateway side.
    await until(() => gw.inFlight === 0);
  });

  it('interrupting a tool call returns an aborted result, then applies the message', async () => {
    const g = gateTool();
    gw.enqueue({ toolCalls: [{ id: 't1', name: 'slow', args: {} }] }, { text: 'changed course' });
    const rt = makeRuntime(gw, { tools: [g.tool] });
    const s = rt.createSession();
    const run = s.send('do the slow thing').done;
    await until(g.started);
    s.steer('never mind, do X', 'interrupt');
    const r = await run;
    expect(r.text).toBe('changed course');
    const kinds = s.messages().map((m) => m.kind);
    expect(kinds).toEqual(['user', 'assistant', 'tool_results', 'steer', 'assistant']);
    const result = s.messages()[2]!.content[0]!;
    expect(result.type === 'tool_result' && result.isError).toBe(true);
    expect(result.type === 'tool_result' && result.content).toContain('interrupted');
  });

  it('several interrupts in a row: every message arrives once, in order', async () => {
    let n = 0;
    gw.onRequest(() => (++n < 3 ? { text: ['streaming', ' more'], hangAfterChunks: 1 } : { text: 'settled' }));
    const rt = makeRuntime(gw);
    const events = captureEvents(rt);
    const s = rt.createSession();
    const run = s.send('go').done;
    await until(() => events.filter((e) => e.type === 'text.delta').length >= 1);
    s.steer('first change', 'interrupt');
    await until(() => events.filter((e) => e.type === 'text.delta').length >= 2);
    s.steer('second change', 'interrupt');
    expect((await run).text).toBe('settled');
    const steers = s.messages().filter((m) => m.kind === 'steer').map(textOf);
    expect(steers).toEqual(['first change', 'second change']);
    expect(userTexts(gw.requests[2]!.body)).toEqual(['go', 'first change', 'second change']);
  });

  it('abort stops the run and leaves the session usable', async () => {
    gw.enqueue({ text: ['a', 'b'], hangAfterChunks: 1 }, { text: 'fresh' });
    const rt = makeRuntime(gw);
    const events = captureEvents(rt);
    const s = rt.createSession();
    const run = s.send('long').done;
    await until(() => events.some((e) => e.type === 'text.delta'));
    s.abort();
    expect((await run).reason).toBe('aborted');
    expect(s.status).toBe('aborted');
    expect((await s.send('again').done).text).toBe('fresh');
  });
});
