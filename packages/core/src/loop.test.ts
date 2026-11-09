// Agent loop: tool round trips, events, traceable records, cost.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
      expect(t.target).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(t.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(traces.map((t) => t.inputTokens)).toEqual([200, 300, 400]);
    const jsonl = rt.exportTraces();
    expect(jsonl.split('\n')).toHaveLength(3);
    expect(jsonl).not.toContain('test-key');
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
