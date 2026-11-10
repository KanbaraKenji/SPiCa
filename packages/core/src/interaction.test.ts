// Confirmation of irreversible actions and ask_user cards.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway } from './testing/helpers.ts';
import { askUserTool, suggestActionsTool } from './tools/agent-tools.ts';
import type { Tool } from './tools/types.ts';

// gateways, child processes and local servers start slowly when several full runs share the machine
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
beforeEach(async () => {
  gw = await startGateway();
});
afterEach(async () => {
  await gw.stop();
});

function sendMailTool(sent: string[]): Tool {
  return {
    spec: {
      name: 'send_mail',
      description: 'Send an email',
      inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
    },
    irreversible: true,
    async execute(input) {
      sent.push(String(input.to));
      return { content: `sent to ${String(input.to)}` };
    },
  };
}

const lookupTool: Tool = {
  spec: { name: 'lookup', description: 'lookup', inputSchema: { type: 'object' } },
  async execute() {
    return { content: 'lookup result' };
  },
};

describe('confirmation', () => {
  it('pauses before an irreversible tool, runs it after approval, then continues', async () => {
    const sent: string[] = [];
    gw.enqueue(
      {
        toolCalls: [
          { id: 'm1', name: 'send_mail', args: { to: 'a@example.com' } },
          { id: 'l1', name: 'lookup', args: {} },
        ],
      },
      { text: 'Mail sent.' },
    );
    const rt = makeRuntime(gw, { tools: [sendMailTool(sent), lookupTool] });
    const events = captureEvents(rt);
    const s = rt.createSession();
    const first = await s.send('mail them').done;

    expect(first.reason).toBe('awaiting_confirm');
    expect(s.status).toBe('awaiting_confirm');
    expect(sent).toEqual([]); // not sent yet
    expect(s.pending()).toMatchObject([{ kind: 'confirm', callId: 'm1', toolName: 'send_mail', input: { to: 'a@example.com' } }]);
    expect(events.some((e) => e.type === 'confirm.request' && e.callId === 'm1')).toBe(true);
    expect(gw.requests).toHaveLength(1);

    const resumed = await (await s.confirm('m1', true))!;
    expect(resumed).toMatchObject({ reason: 'completed', text: 'Mail sent.' });
    expect(sent).toEqual(['a@example.com']);
    // Both results (the confirmed one and the sibling that ran right away) went back in one message, in call order.
    const results = s.messages()[2]!.content.map((b) => (b.type === 'tool_result' ? `${b.toolUseId}:${b.content.split('\n')[1]}` : ''));
    expect(results).toEqual(['m1:sent to a@example.com', 'l1:lookup result']);
    expect(s.pending()).toEqual([]);
  });

  it('a declined action is reported to the model and not executed', async () => {
    const sent: string[] = [];
    gw.enqueue({ toolCalls: [{ id: 'm1', name: 'send_mail', args: { to: 'b@example.com' } }] }, { text: 'Understood, not sent.' });
    const rt = makeRuntime(gw, { tools: [sendMailTool(sent)] });
    const s = rt.createSession();
    await s.send('mail').done;
    const r = await (await s.confirm('m1', false))!;
    expect(r.text).toBe('Understood, not sent.');
    expect(sent).toEqual([]);
    const res = s.messages()[2]!.content[0]!;
    expect(res.type === 'tool_result' && res.isError && res.content).toContain('declined');
  });

  it('a plugin can switch an irreversible tool to automatic', async () => {
    const sent: string[] = [];
    gw.enqueue({ toolCalls: [{ id: 'm1', name: 'send_mail', args: { to: 'c@example.com' } }] }, { text: 'done' });
    const rt = makeRuntime(gw, { tools: [sendMailTool(sent)] });
    rt.hooks.register('company-policy', { beforeTool: (call) => (call.name === 'send_mail' ? { action: 'auto' } : undefined) });
    const r = await rt.createSession().send('mail').done;
    expect(r.reason).toBe('completed');
    expect(sent).toEqual(['c@example.com']);
  });

  it('a plugin can require confirmation for an ordinary tool', async () => {
    gw.enqueue({ toolCalls: [{ id: 'l1', name: 'lookup', args: {} }] });
    const rt = makeRuntime(gw, { tools: [lookupTool] });
    rt.hooks.register('cautious', { beforeTool: () => ({ action: 'confirm', reason: 'reads customer data' }) });
    const s = rt.createSession();
    expect((await s.send('look').done).reason).toBe('awaiting_confirm');
    expect(s.pending()[0]).toMatchObject({ kind: 'confirm', reason: 'reads customer data' });
  });

  it('a message sent while waiting is applied after the answer, abort cancels the wait', async () => {
    const sent: string[] = [];
    gw.enqueue({ toolCalls: [{ id: 'm1', name: 'send_mail', args: { to: 'd@example.com' } }] }, { text: 'ok' });
    const rt = makeRuntime(gw, { tools: [sendMailTool(sent)] });
    const s = rt.createSession();
    await s.send('mail').done;
    const queued = s.send('use the formal tone');
    expect(queued.started).toBe(false);
    await (await s.confirm('m1', true))!;
    expect(await queued.done).toMatchObject({ reason: 'completed' });
    expect(s.messages().map((m) => m.kind)).toEqual(['user', 'assistant', 'tool_results', 'steer', 'assistant']);

    // Abort while waiting
    gw.enqueue({ toolCalls: [{ id: 'm2', name: 'send_mail', args: { to: 'e@example.com' } }] });
    await s.send('mail again').done;
    s.abort();
    expect(s.status).toBe('aborted');
    expect(s.pending()).toEqual([]);
    const last = s.messages().at(-1)!;
    expect(last.kind).toBe('tool_results');
    expect(sent).toEqual(['d@example.com']);
  });
});

describe('suggest_actions', () => {
  it('emits a card event and does not pause the run', async () => {
    gw.enqueue(
      {
        toolCalls: [
          {
            id: 'sa1',
            name: 'suggest_actions',
            args: { title: 'Next steps', actions: [{ label: 'Draft reply', prompt: 'Draft a reply to the supplier' }, { label: 'bad' }] },
          },
        ],
      },
      { text: 'Here are some options.' },
    );
    const rt = makeRuntime(gw, { tools: [suggestActionsTool] });
    const events = captureEvents(rt);
    const r = await rt.createSession().send('what now?').done;
    expect(r).toMatchObject({ reason: 'completed', text: 'Here are some options.' });
    expect(events.find((e) => e.type === 'suggest.actions')).toMatchObject({
      callId: 'sa1',
      title: 'Next steps',
      actions: [{ label: 'Draft reply', prompt: 'Draft a reply to the supplier' }],
    });
  });
});

describe('ask_user', () => {
  it('pauses with a question card and continues with the answer', async () => {
    gw.enqueue(
      { text: 'One question first.', toolCalls: [{ id: 'q1', name: 'ask_user', args: { question: 'Which region?', options: ['EU', 'US'] } }] },
      { text: 'Using EU.' },
    );
    const rt = makeRuntime(gw, { tools: [askUserTool] });
    const events = captureEvents(rt);
    const s = rt.createSession();
    const first = await s.send('set it up').done;
    expect(first.reason).toBe('awaiting_answer');
    expect(s.status).toBe('awaiting_answer');
    expect(events.find((e) => e.type === 'ask.request')).toMatchObject({ callId: 'q1', question: 'Which region?', options: ['EU', 'US'] });

    const r = await s.answer('q1', 'EU')!;
    expect(r.text).toBe('Using EU.');
    const toolMsg = (gw.requests[1]!.body.messages as { role: string; content: string }[]).find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toMatch(/^\[fetched at .+\]\nUser answered: EU$/);
    expect(() => s.answer('q1', 'again')).toThrow(/no pending/);
  });
});
