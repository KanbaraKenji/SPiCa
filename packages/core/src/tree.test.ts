// Session tree: spawning sub-agents, parallel work, reports, and relaying
// what the user says or decides in a child back to the parent.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeGateway, ReceivedRequest, ScriptedReply } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, until } from './testing/helpers.ts';

let gw: FakeGateway;
beforeEach(async () => {
  gw = await startGateway();
});
afterEach(async () => {
  await gw.stop();
});

type OAMsg = { role: string; content: string | null };
const msgsOf = (r: ReceivedRequest) => r.body.messages as OAMsg[];
const has = (r: ReceivedRequest, needle: string) => JSON.stringify(r.body.messages).includes(needle);

/** Scripted manager + two workers sharing one gateway. */
function teamScript(): (r: ReceivedRequest) => ScriptedReply {
  return (r) => {
    if (has(r, 'COORDINATE')) {
      const toolMsgs = msgsOf(r).filter((m) => m.role === 'tool').length;
      if (toolMsgs === 0) {
        return {
          toolCalls: [
            { id: 's1', name: 'spawn_agent', args: { title: 'Doc A', task: 'TASK-A: summarize doc A' } },
            { id: 's2', name: 'spawn_agent', args: { title: 'Doc B', task: 'TASK-B: summarize doc B' } },
          ],
        };
      }
      if (toolMsgs === 2) return { toolCalls: [{ id: 'w1', name: 'wait_agents', args: {} }] };
      return { text: 'Combined report.' };
    }
    if (has(r, 'TASK-A')) {
      return has(r, 'focus on costs') ? { text: 'Summary A (costs only)' } : { text: 'Summary A', delayMs: 150 };
    }
    if (has(r, 'TASK-B')) return { text: 'Summary B', delayMs: 50 };
    return { text: 'unexpected' };
  };
}

describe('session tree', () => {
  it('manager spawns two sub-agents in parallel, waits, and gets the user change made inside a child', async () => {
    gw.onRequest(teamScript());
    const rt = makeRuntime(gw);
    const events = captureEvents(rt);
    const pm = rt.createSession({ role: 'manager', title: 'PM' });
    const run = pm.send('COORDINATE: summarize two docs').done;

    await until(() => rt.children(pm.id).length === 2 && gw.requests.some((r) => has(r, 'TASK-A')));
    const [a, b] = rt.children(pm.id);
    expect(a!.info()).toMatchObject({ role: 'worker', title: 'Doc A', parentId: pm.id });
    expect(gw.maxInFlight).toBeGreaterThanOrEqual(2); // both children were working at the same time

    // The user enters child A while it works and changes direction.
    a!.send('focus on costs');
    const result = await run;
    expect(result.text).toBe('Combined report.');

    // The manager's final request contains the relay note and the updated report.
    const final = gw.requests.filter((r) => has(r, 'COORDINATE')).at(-1)!;
    const all = JSON.stringify(final.body.messages);
    expect(all).toContain('The user wrote in that session: \\"focus on costs\\"');
    expect(all).toContain('Summary A (costs only)');
    expect(all).toContain('Summary B');

    // Relay is stored and evented; children finished as one-off workers.
    expect(rt.store.listRelays(pm.id).map((r) => `${r.kind}:${r.childId === a!.id ? 'A' : 'B'}`)).toEqual(
      expect.arrayContaining(['user_message:A', 'report:A', 'report:B']),
    );
    expect(events.some((e) => e.type === 'relay' && e.sessionId === pm.id && e.fromSessionId === a!.id)).toBe(true);
    expect(events.filter((e) => e.type === 'child.report' && e.sessionId === pm.id)).toHaveLength(2);
    expect(a!.status).toBe('done');
    expect(b!.status).toBe('done');
    // Every report is a report message in the manager, with structured meta for the UI.
    const reports = pm.messages().filter((m) => m.kind === 'report');
    expect(reports.map((m) => m.meta?.fromSessionId).sort()).toEqual([a!.id, b!.id].sort());
    expect(reports.every((m) => m.meta?.kind === 'report' && typeof m.meta.text === 'string')).toBe(true);
    // The relay note sits after the wait_agents result, at a turn boundary.
    const kinds = pm.messages().map((m) => m.kind);
    expect(kinds.indexOf('relay')).toBeGreaterThan(kinds.lastIndexOf('tool_results'));
  });

  it('a report from a child reaches an idle parent as a note in its history', async () => {
    gw.onRequest((r) => (has(r, 'child job') ? { text: 'child finished: 3 items' } : { text: 'parent reply' }));
    const rt = makeRuntime(gw);
    const parent = rt.createSession({ role: 'manager' });
    const child = rt.createSession({ parentId: parent.id, title: 'Helper' });
    await child.send('child job', { author: 'parent' }).done;
    const notes = parent.messages();
    expect(notes.map((m) => m.kind)).toEqual(['report']);
    expect(JSON.stringify(notes[0]!.content)).toContain('child finished: 3 items');
    // A parent-authored task is not relayed as "the user wrote".
    expect(rt.store.listRelays(parent.id).map((r) => r.kind)).toEqual(['report']);
    // The parent sees it on its next run.
    await parent.send('what did the helper find?').done;
    expect(JSON.stringify(gw.requests.at(-1)!.body.messages)).toContain('child finished: 3 items');
  });

  it('decisions made in a child are relayed to the parent and marked as decisions', async () => {
    gw.onRequest((r) =>
      has(r, 'Use metric') && !has(r, 'Decision recorded.')
        ? { toolCalls: [{ id: 'd1', name: 'record_decision', args: { decision: 'Units switched to metric' } }] }
        : { text: 'noted' },
    );
    const rt = makeRuntime(gw);
    const parent = rt.createSession({ role: 'manager' });
    const child = rt.createSession({ parentId: parent.id, title: 'Specs' });
    await child.send('Use metric from now on').done;
    rt.recordDecision(child.id, 'Deadline moved to Friday', 'user');
    const relays = parent.messages().filter((m) => m.kind === 'relay');
    const texts = relays.map((m) => JSON.stringify(m.content));
    expect(texts.some((t) => t.includes('Use metric from now on'))).toBe(true);
    expect(texts.some((t) => t.includes('Decision recorded there: Units switched to metric'))).toBe(true);
    expect(texts.some((t) => t.includes('Decision made by the user there: Deadline moved to Friday'))).toBe(true);
    const decisions = relays.filter((m) => m.meta?.kind === 'decision');
    expect(decisions).toHaveLength(2);
    // Structured fields for the UI: no need to parse the English note text.
    expect(decisions.map((m) => m.meta)).toEqual([
      expect.objectContaining({ author: 'child', kind: 'decision', fromSessionId: child.id, fromTitle: 'Specs', text: 'Units switched to metric', by: 'agent' }),
      expect.objectContaining({ kind: 'decision', text: 'Deadline moved to Friday', by: 'user' }),
    ]);
    expect(relays[0]!.meta).toMatchObject({ kind: 'relay', text: 'Use metric from now on', at: expect.stringMatching(/T.*[+-]\d\d:\d\d$/) });
  });

  it('a child that finished before wait_agents is not reported twice', async () => {
    let parentCalls = 0;
    gw.onRequest((r) => {
      if (has(r, 'LEAD')) {
        parentCalls++;
        if (parentCalls === 1) return { toolCalls: [{ id: 's1', name: 'spawn_agent', args: { title: 'Quick', task: 'QUICK-TASK' } }] };
        if (parentCalls === 2) return { toolCalls: [{ id: 'w1', name: 'wait_agents', args: {} }], delayMs: 150 };
        return { text: 'lead done' };
      }
      return { text: 'QUICK-REPORT-TEXT' };
    });
    const rt = makeRuntime(gw);
    const lead = rt.createSession({ role: 'manager' });
    await lead.send('LEAD').done;
    const all = JSON.stringify(lead.messages().map((m) => m.content)); // what the model sees
    expect(all.split('QUICK-REPORT-TEXT')).toHaveLength(2); // exactly once
    expect(lead.messages().find((m) => m.kind === 'report')!.meta).toMatchObject({ kind: 'report', fromTitle: 'Quick', text: 'QUICK-REPORT-TEXT' });
    expect(all).toContain('report delivered as a note');
  });

  it('sessions have no invented display name and can be renamed', async () => {
    const rt = makeRuntime(gw);
    const events = captureEvents(rt);
    const s = rt.createSession();
    expect(s.info().title).toBeNull();
    expect(s.rename('  Budget review ').title).toBe('Budget review');
    expect(s.rename('').title).toBeNull();
    expect(events.filter((e) => e.type === 'session.renamed').map((e) => (e.type === 'session.renamed' ? e.title : 'x'))).toEqual(['Budget review', null]);
  });

  it('message_agent only reaches own children', async () => {
    gw.onRequest((r) => {
      if (has(r, 'BOSS') && !has(r, 'Sent;') && !has(r, 'No sub-agent')) {
        return { toolCalls: [{ id: 'm1', name: 'message_agent', args: { id: 'ses_not_mine', text: 'hi' } }] };
      }
      return { text: 'ok' };
    });
    const rt = makeRuntime(gw);
    const boss = rt.createSession();
    await boss.send('BOSS').done;
    expect(JSON.stringify(boss.messages())).toContain('No sub-agent with id ses_not_mine belongs to you');
  });
});

describe('AgentApi adapter', () => {
  it('drives a session through the protocol interface', async () => {
    const { createAgentApi } = await import('./api.ts');
    gw.onRequest(() => ({ text: 'api reply' }));
    const rt = makeRuntime(gw);
    const api = createAgentApi(rt);
    const info = await api.createSession({ title: 'via api' });
    expect(await api.send(info.id, 'hello')).toMatchObject({ started: true });
    await rt.session(info.id)!.idle();
    const msgs = await api.getMessages(info.id);
    expect(msgs.map((m) => m.kind)).toEqual(['user', 'assistant']);
    expect((await api.listSessions()).map((s) => s.title)).toEqual(['via api']);
    expect((await api.exportTraces()).split('\n')).toHaveLength(1);
  });
});
