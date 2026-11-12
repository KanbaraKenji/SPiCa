// The same call again and again (repeat-guard.ts): a note for the model at defaults.repeatRemind, not run and the
// run stopped at defaults.repeatStop; off when neither is given.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPEAT_REMINDER_MARK, REPEAT_STOP_MARK } from '@spica/protocol';
import { callKey, comparableResult, repeatsBefore } from './repeat-guard.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway } from './testing/helpers.ts';
import type { Message } from './types.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const msg = (over: Partial<Message>): Message => ({ id: 'm', sessionId: 's', seq: 1, role: 'user', kind: 'user', content: [], createdAt: '', ...over });
let n = 0;
/** One call and its result, as two messages. */
const step = (name: string, input: unknown, result: string): Message[] => {
  const id = `c${++n}`;
  return [msg({ id: `a${n}`, role: 'assistant', kind: 'assistant', content: [{ type: 'tool_use', id, name, input }] }), msg({ id: `r${n}`, kind: 'tool_results', meta: { author: 'runtime' }, content: [{ type: 'tool_result', toolUseId: id, content: result }] })];
};

describe('what counts as the same call', () => {
  it('same tool and input (key order aside) with one same result, in a row, back to what the user typed', () => {
    expect(callKey('t', { a: 1, b: [2, { c: 3, d: 4 }] })).toBe(callKey('t', { b: [2, { d: 4, c: 3 }], a: 1 }));
    const same = [...step('t', { p: 1 }, 'x'), ...step('t', { p: 1 }, 'x'), ...step('t', { p: 1 }, 'x')];
    expect(repeatsBefore(same, 'now', 't', { p: 1 })).toEqual({ count: 3, result: 'x' });
    // other input, another tool in between, or a different result: the row ends there
    expect(repeatsBefore([...same, ...step('t', { p: 2 }, 'x')], 'now', 't', { p: 1 }).count).toBe(0);
    expect(repeatsBefore([...step('t', { p: 1 }, 'x'), ...step('write', {}, 'ok'), ...step('t', { p: 1 }, 'x')], 'now', 't', { p: 1 }).count).toBe(1);
    expect(repeatsBefore([...step('t', { p: 1 }, '10%'), ...step('t', { p: 1 }, '40%'), ...step('t', { p: 1 }, '80%')], 'now', 't', { p: 1 }).count).toBe(1);
    // the user wrote: counted from there
    expect(repeatsBefore([...same, msg({ id: 'u' }), ...step('t', { p: 1 }, 'x')], 'now', 't', { p: 1 }).count).toBe(1);
    // a parent's message is not the user's
    expect(repeatsBefore([...same, msg({ id: 'u', meta: { author: 'parent' } }), ...step('t', { p: 1 }, 'x')], 'now', 't', { p: 1 }).count).toBe(4);
  });

  it('results compared without the fetch-time line, the outside-content fence and a note added to them', () => {
    expect(comparableResult('[fetched at 2026-11-13T01:00:00Z]\nhello')).toBe('hello');
    expect(comparableResult('<untrusted_data source="web">\n[fetched at 2026-11-13T01:00:00Z]\nhello\n</untrusted_data>')).toBe('hello');
    expect(comparableResult(`hello\n\n${REPEAT_REMINDER_MARK} You have now…`)).toBe('hello');
  });
});

describe('a conversation calling the same thing again and again', () => {
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = await startGateway();
  });
  afterEach(async () => {
    await gw.stop();
  });

  const runtime = (limits: { repeatRemind?: number; repeatStop?: number }) => makeRuntime(gw, { defaults: { providerId: 'fake-openai', model: 'fake-model', maxTokens: 512, ...limits } });
  /** Calls list_dir on the same folder until `upTo` requests were made, then answers. */
  const loop = (upTo: number, between?: (i: number) => void) => {
    let i = 0;
    gw.onRequest(() => {
      i++;
      between?.(i);
      return i <= upTo ? { toolCalls: [{ name: 'list_dir', args: { path: '.' } }] } : { text: 'done' };
    });
  };
  const bodies = () => gw.requests.map((r) => JSON.stringify(r.body));

  it('the 3rd same call gets a note for the model; the 8th is not run and the run stops (repeated)', async () => {
    loop(20);
    const rt = runtime({ repeatRemind: 3, repeatStop: 8 });
    const s = rt.createSession();
    const r = await s.send('look around').done;
    expect(r.reason).toBe('repeated');
    expect(s.status).toBe('idle');
    // 7 calls ran; the 8th request asked for the 8th call, which was not run
    expect(gw.requests).toHaveLength(8);
    expect(bodies()[2]).not.toContain(REPEAT_REMINDER_MARK); // after the 2nd result
    expect(bodies()[3]).toContain(REPEAT_REMINDER_MARK); // after the 3rd
    const last = s.messages().at(-1)!;
    expect(last.content.some((b) => b.type === 'tool_result' && b.isError === true && b.content.startsWith(REPEAT_STOP_MARK))).toBe(true);
  });

  it('the user writing starts the count again: 继续 gets another 7 calls before the next stop', async () => {
    loop(100);
    const rt = runtime({ repeatRemind: 3, repeatStop: 8 });
    const s = rt.createSession();
    expect((await s.send('look around').done).reason).toBe('repeated');
    expect((await s.send('继续').done).reason).toBe('repeated');
    expect(gw.requests).toHaveLength(16);
  });

  it('a result that changes (polling) is no repeat; nor is another call in between', async () => {
    const rt = runtime({ repeatRemind: 3, repeatStop: 8 });
    const cwd = mkdtempSync(join(tmpdir(), 'spica-repeat-'));
    const s = rt.createSession({ cwd });
    loop(10, (i) => writeFileSync(join(cwd, `step-${i}.txt`), 'x'));
    const r = await s.send('wait for it').done;
    expect(r.reason).toBe('completed');
    expect(bodies().join('')).not.toContain(REPEAT_REMINDER_MARK);

    let i = 0;
    gw.onRequest(() => (++i <= 12 ? { toolCalls: [{ name: 'list_dir', args: { path: i % 2 ? '.' : './' } }] } : { text: 'done' }));
    expect((await s.send('again').done).reason).toBe('completed');
  });

  it('off when neither number is given (scripts, the MCP service): nothing added, nothing stopped', async () => {
    loop(10);
    const rt = runtime({});
    const s = rt.createSession();
    expect((await s.send('look around').done).reason).toBe('completed');
    expect(gw.requests).toHaveLength(11);
    expect(bodies().join('')).not.toContain(REPEAT_REMINDER_MARK);
  });
});
