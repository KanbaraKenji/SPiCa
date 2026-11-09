// Agent loop: tool round trips, events, traceable records, cost.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spicaMcpTools } from './mcp/server.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { anthropicProvider, captureEvents, makeRuntime, startGateway, tempDir } from './testing/helpers.ts';

let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  gw = await startGateway();
  ({ dir, cleanup } = await tempDir());
  await writeFile(join(dir, 'notes.txt'), 'The launch code is 4471.\nOwner: Mika\n');
});
afterEach(async () => {
  await gw.stop();
  await cleanup();
});

describe('agent loop', () => {
  it('runs read_file → grep → answer and records everything', async () => {
    gw.enqueue(
      { text: 'Reading.', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'notes.txt' } }], usage: { input: 200, output: 10 } },
      { toolCalls: [{ id: 'c2', name: 'grep', args: { pattern: 'Owner' } }], usage: { input: 300, output: 8 } },
      { text: ['The code is ', '4471.'], usage: { input: 400, output: 6 } },
    );
    const rt = makeRuntime(gw, { cwd: dir });
    const events = captureEvents(rt);
    const s = rt.createSession({ title: 'test' });
    const { done } = s.send('What is the launch code?');
    const result = await done;

    expect(result).toMatchObject({ reason: 'completed', text: 'The code is 4471.' });
    const msgs = s.messages();
    expect(msgs.map((m) => m.kind)).toEqual(['user', 'assistant', 'tool_results', 'assistant', 'tool_results', 'assistant']);
    const firstResult = msgs[2]!.content[0]!;
    expect(firstResult.type === 'tool_result' && firstResult.content).toMatch(/^\[fetched at \d{4}-\d\d-\d\dT[\d:.]+[+-]\d\d:\d\d\]\n/);
    expect(firstResult.type === 'tool_result' && firstResult.content).toContain('4471');

    // The second request carried the first tool result back to the model.
    const second = gw.requests[1]!.body.messages as { role: string; tool_call_id?: string }[];
    expect(second.some((m) => m.role === 'tool' && m.tool_call_id === 'c1')).toBe(true);

    // Events: status flow, deltas, tool start/end pairs, usage, run end.
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'tool.start')).toHaveLength(2);
    expect(types.filter((t) => t === 'tool.end')).toHaveLength(2);
    expect(types.filter((t) => t === 'usage')).toHaveLength(3);
    expect(types[types.length - 1]).toBe('run.end');
    const statuses = events.flatMap((e) => (e.type === 'status' ? [e.status] : []));
    expect(statuses).toContain('thinking');
    expect(statuses).toContain('tool');
    expect(statuses[statuses.length - 1]).toBe('idle');
    expect(events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq)).toBe(true);

    // One traceable record per model call, no secrets, host only.
    const traces = rt.store.listTraces();
    expect(traces).toHaveLength(3);
    for (const t of traces) {
      expect(t).toMatchObject({ kind: 'model', sessionId: s.id, initiator: 'model', status: 'ok', attempts: 1 });
      expect(t.target).toBe('fake-openai'); // provider id, not the endpoint address
      expect(t.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(traces.map((t) => t.inputTokens)).toEqual([200, 300, 400]);
    const jsonl = rt.exportTraces();
    expect(jsonl.split('\n')).toHaveLength(3);
    expect(jsonl).not.toContain('test-key');
    expect(jsonl).not.toContain('127.0.0.1');
    expect(rt.ledger.sessionUsd(s.id)).toBeGreaterThan(0);
  });

  it('returns tool errors to the model instead of failing the run', async () => {
    gw.enqueue(
      {
        toolCalls: [
          { id: 'a', name: 'no_such_tool', args: {} },
          { id: 'b', name: 'read_file', args: {} },
          { id: 'c', name: 'read_file', args: { path: 'missing.txt' } },
        ],
      },
      { text: 'done' },
    );
    const rt = makeRuntime(gw, { cwd: dir });
    const s = rt.createSession();
    await s.send('go').done;
    const results = s.messages()[2]!.content;
    expect(results).toHaveLength(3);
    expect(results.every((b) => b.type === 'tool_result' && b.isError)).toBe(true);
    expect(JSON.stringify(results)).toContain('Unknown tool');
    expect(JSON.stringify(results)).toContain('missing required field');
    expect(JSON.stringify(results)).toContain('File not found');
  });

  it('runs parallel tool calls and returns results in call order in one message', async () => {
    gw.enqueue(
      {
        toolCalls: [
          { id: 'p1', name: 'read_file', args: { path: 'notes.txt' } },
          { id: 'p2', name: 'list_dir', args: {} },
        ],
      },
      { text: 'ok' },
    );
    const rt = makeRuntime(gw, { cwd: dir });
    const s = rt.createSession();
    await s.send('go').done;
    const results = s.messages()[2]!.content.map((b) => (b.type === 'tool_result' ? b.toolUseId : ''));
    expect(results).toEqual(['p1', 'p2']);
  });

  it('stops at maxTurns', async () => {
    gw.onRequest(() => ({ toolCalls: [{ name: 'list_dir', args: {} }] }));
    const rt = makeRuntime(gw, { cwd: dir });
    const s = rt.createSession({ maxTurns: 2 });
    const r = await s.send('loop forever').done;
    expect(r.reason).toBe('max_turns');
    expect(gw.requests).toHaveLength(2);
  });

  it('surfaces provider errors as an error run end with a trace', async () => {
    gw.enqueue({ status: 400, errorBody: '{"error":{"message":"bad model"}}' });
    const rt = makeRuntime(gw, { cwd: dir });
    const events = captureEvents(rt);
    const s = rt.createSession();
    const r = await s.send('hi').done;
    expect(r.reason).toBe('error');
    expect(r.detail).toContain('bad model');
    expect(s.status).toBe('error');
    expect(rt.store.listTraces()[0]).toMatchObject({ status: 'error', httpStatus: 400 });
    expect(events.some((e) => e.type === 'error')).toBe(true);
    // The session can be used again.
    gw.enqueue({ text: 'recovered' });
    expect((await s.send('again').done).text).toBe('recovered');
  });

  it('works the same through the Anthropic provider', async () => {
    gw.enqueue(
      { reasoning: 'need file', toolCalls: [{ id: 'tu1', name: 'read_file', args: { path: 'notes.txt' } }] },
      { text: 'Owner is Mika.' },
    );
    const rt = makeRuntime(gw, {
      cwd: dir,
      providers: [anthropicProvider(gw)],
      defaults: { providerId: 'fake-anthropic', model: 'claude-haiku-5-5', maxTokens: 256 },
    });
    const s = rt.createSession();
    const r = await s.send('who owns it?').done;
    expect(r.text).toBe('Owner is Mika.');
    // Thinking with signature is echoed back; tool_result leads the next user turn.
    const second = gw.requests[1]!.body.messages as { role: string; content: { type: string }[] }[];
    expect(second[1]!.content[0]!.type).toBe('thinking');
    expect(second[2]!.content[0]!.type).toBe('tool_result');
  });

  it('tells the model to answer in the user language, interface language first', async () => {
    gw.onRequest(() => ({ text: 'ok' }));
    const rt = makeRuntime(gw, { cwd: dir, locale: 'ja-JP' });
    await rt.createSession().send('hi').done;
    await rt.createSession({ locale: 'en-US' }).send('hi').done;
    const sys = (i: number) => (gw.requests[i]!.body.messages as { content: string }[])[0]!.content;
    expect(sys(0)).toContain('Reply in the language of the latest message the user typed themselves');
    expect(sys(0)).toContain('interface language: ja-JP');
    expect(sys(1)).toContain('interface language: en-US');
    expect(makeRuntime(gw).createSession().config.locale).toBe('zh-CN');
    // a session that only got messages from the system / other agents is told to use the interface language
    const rt2 = makeRuntime(gw, { cwd: dir });
    const pm = rt2.createSession({ templateId: 'project-manager' });
    await pm.send('New mail for this project. Subject: hello', { author: 'parent' }).done;
    const last = (gw.requests.at(-1)!.body.messages as { content: string }[])[0]!.content;
    expect(last).toContain('Write everything for the user in the interface language: zh-CN');
    expect(last).not.toContain('latest message the user typed');
  });

  it('a tool that was turned off is refused cleanly and the model is told once', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    rt.tools.register({ spec: { name: 'notes__read_note', description: 'read', inputSchema: { type: 'object' } }, execute: async () => ({ content: 'plugins work' }) }, 'plugin:notes');
    const run = spicaMcpTools(rt, []).find((t) => t.name === 'spica_run')!;
    gw.enqueue({ toolCalls: [{ id: 'n1', name: 'notes__read_note', args: {} }] }, { text: 'It says plugins work.' });
    const first = (await run.run({ text: 'read the note' })) as { sessionId: string; toolCalls: string[] };
    expect(first.toolCalls).toEqual(['notes__read_note']);

    rt.tools.unregisterSource('plugin:notes'); // the plugin is turned off
    // the model still tries the old tool from what it sees in the history
    gw.enqueue({ toolCalls: [{ id: 'n2', name: 'notes__read_note', args: {} }] }, { text: 'no notebook tool' }, { text: 'ok' });
    const second = (await run.run({ session_id: first.sessionId, text: 'read it again' })) as { toolCalls: string[]; unavailableToolCalls: string[]; answer: string };
    expect(second).toMatchObject({ toolCalls: [], unavailableToolCalls: ['notes__read_note'], answer: 'no notebook tool' });
    const s = rt.session(first.sessionId)!;
    const result = s.messages().filter((m) => m.kind === 'tool_results').at(-1)!.content[0]!;
    expect(result.type === 'tool_result' && result.content).toMatch(/no longer available.*Nothing was run/);
    expect(rt.store.listToolCalls(s.id).at(-1)!.status).toBe('unavailable');
    // the request carried a runtime note before the user's words were answered, and no longer offered the tool
    const req = gw.requests.at(-2)!.body as { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] };
    expect((req.tools ?? []).some((t) => t.function.name === 'notes__read_note')).toBe(false);
    expect(JSON.stringify(req.messages)).toContain('no longer available (turned off or removed): notes__read_note');
    const notes = s.messages().filter((m) => m.meta?.toolsUnavailable);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'note', meta: { author: 'runtime', toolsUnavailable: ['notes__read_note'] } });
    // said once: the next run adds no second note
    await s.send('thanks').done;
    expect(s.messages().filter((m) => m.meta?.toolsUnavailable)).toHaveLength(1);
  });

  it('child sessions carry their parent chain in events and traces', async () => {
    gw.onRequest(() => ({ text: 'hi' }));
    const rt = makeRuntime(gw, { cwd: dir });
    const events = captureEvents(rt);
    const top = rt.createSession({ role: 'top' });
    const pm = rt.createSession({ parentId: top.id, role: 'manager' });
    const worker = rt.createSession({ parentId: pm.id });
    expect(worker.parentChain).toEqual([pm.id, top.id]);
    await worker.send('x').done;
    expect(rt.store.listTraces({ sessionId: worker.id })[0]!.parentChain).toEqual([pm.id, top.id]);
    expect(events.find((e) => e.sessionId === worker.id && e.type === 'text.delta')!.parentChain).toEqual([pm.id, top.id]);
    expect(events.some((e) => e.type === 'child.spawned' && e.sessionId === pm.id && e.childId === worker.id)).toBe(true);
  });
});
