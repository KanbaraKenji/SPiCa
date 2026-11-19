// A call that runs other tools as its steps (browser_batch): each step is judged as a call of its own would be,
// a confirmation asked on a card right then, and outside content an earlier step brought counts for the later ones.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, tempDir, until } from './testing/helpers.ts';
import type { Tool } from './tools/types.ts';
import type { Runtime } from './runtime.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  gw = await startGateway();
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await gw.stop();
  await cleanup();
});

function setup(rt: Runtime, ran: string[]) {
  const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
    spec: { name, description: name, inputSchema: { type: 'object' } },
    execute: async () => (ran.push(name), { content: name === 'page_read' ? 'A page. See https://far.example/next' : `${name} done` }),
    ...extra,
  });
  rt.tools.register(tool('page_read', { untrusted: 'web' }));
  rt.tools.register(tool('page_act'));
  rt.tools.register(tool('page_open', { targetUrl: (i) => (typeof i.url === 'string' ? i.url : undefined) }));
  rt.tools.register(tool('page_ask', { interaction: 'ask' }));
  // the shell's hook: acting on a page is asked about (in either approval mode)
  rt.hooks.register('test', { beforeTool: (call) => (call.name === 'page_act' ? { action: 'confirm', reason: 'Submit a form\nshop.example', irreversible: true } : undefined) });
  rt.tools.register({
    spec: { name: 'runner', description: 'runs steps', inputSchema: { type: 'object' } },
    async execute(input, ctx) {
      const out: string[] = [];
      for (const s of (input.steps as { name: string; input?: Record<string, unknown> }[]) ?? []) {
        const r = await ctx.step!(s.name, s.input ?? {});
        out.push(`${s.name}:${r.status}`);
        if (r.isError) break;
      }
      return { content: out.join(' ') };
    },
  });
}

describe('steps of a call', () => {
  it('a step that needs a yes asks on a card while the call runs; allowed, it runs and the call goes on', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    const events = captureEvents(rt);
    const ran: string[] = [];
    setup(rt, ran);
    gw.enqueue({ toolCalls: [{ id: 'b1', name: 'runner', args: { steps: [{ name: 'page_act' }, { name: 'page_read' }] } }] }, { text: 'done' });
    const s = rt.createSession();
    const h = s.send('Go.');
    await until(() => events.some((e) => e.type === 'confirm.request'));
    const card = events.find((e) => e.type === 'confirm.request');
    expect(card).toMatchObject({ callId: 'b1.1', name: 'page_act', reason: 'Submit a form\nshop.example', irreversible: true, sessionId: s.id });
    // the window rebuilt from history shows it too
    expect(s.pending()).toEqual([expect.objectContaining({ kind: 'confirm', callId: 'b1.1', toolName: 'page_act' })]);
    expect(ran).toEqual([]);
    // the conversation says it waits for the user, then goes on
    expect(s.info().status).toBe('awaiting_confirm');
    expect(rt.resolveViewConfirm('b1.1', true)).toBe(true);
    expect((await h.done).reason).toBe('completed');
    expect(ran).toEqual(['page_act', 'page_read']);
    expect(rt.store.listToolCalls(s.id).find((c) => c.id === 'b1')?.result).toContain('page_act:ok page_read:ok');
    const statuses = events.filter((e) => e.type === 'status').map((e) => (e.type === 'status' ? e.status : ''));
    expect(statuses.slice(statuses.indexOf('awaiting_confirm'), statuses.indexOf('awaiting_confirm') + 2)).toEqual(['awaiting_confirm', 'tool']);
    expect(s.pending()).toEqual([]);
  });

  it('declined: the step is not run and the call is told', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    const events = captureEvents(rt);
    const ran: string[] = [];
    setup(rt, ran);
    gw.enqueue({ toolCalls: [{ id: 'b1', name: 'runner', args: { steps: [{ name: 'page_act' }, { name: 'page_read' }] } }] }, { text: 'ok' });
    const s = rt.createSession();
    const h = s.send('Go.');
    await until(() => events.some((e) => e.type === 'confirm.request'));
    rt.resolveViewConfirm('b1.1', false);
    await h.done;
    expect(ran).toEqual([]);
    expect(rt.store.listToolCalls(s.id).find((c) => c.id === 'b1')?.result).toContain('page_act:declined');
  });

  it('stopping the run while a step waits answers it no', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    const events = captureEvents(rt);
    const ran: string[] = [];
    setup(rt, ran);
    gw.enqueue({ toolCalls: [{ id: 'b1', name: 'runner', args: { steps: [{ name: 'page_act' }] } }] });
    const s = rt.createSession();
    const h = s.send('Go.');
    await until(() => events.some((e) => e.type === 'confirm.request'));
    s.abort();
    await h.done;
    expect(ran).toEqual([]);
    expect(events.some((e) => e.type === 'confirm.resolved' && e.callId === 'b1.1' && !e.approved)).toBe(true);
  });

  it('outside content an earlier step read: a link from it is asked about at the next step', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    const events = captureEvents(rt);
    const ran: string[] = [];
    setup(rt, ran);
    gw.enqueue({ toolCalls: [{ id: 'b1', name: 'runner', args: { steps: [{ name: 'page_read' }, { name: 'page_open', input: { url: 'https://far.example/next' } }] } }] }, { text: 'ok' });
    const s = rt.createSession();
    const h = s.send('Read it.');
    await until(() => events.some((e) => e.type === 'confirm.request'));
    expect(events.find((e) => e.type === 'confirm.request')).toMatchObject({ callId: 'b1.2', name: 'page_open', cause: 'outside_link' });
    rt.resolveViewConfirm('b1.2', true);
    await h.done;
    expect(ran).toEqual(['page_read', 'page_open']);
  });

  it('not a step: unknown tools, the calling tool itself, tools that ask the user', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    const ran: string[] = [];
    setup(rt, ran);
    gw.enqueue({ toolCalls: [{ id: 'b1', name: 'runner', args: { steps: [{ name: 'nope' }] } }] }, { toolCalls: [{ id: 'b2', name: 'runner', args: { steps: [{ name: 'runner' }] } }] }, { toolCalls: [{ id: 'b3', name: 'runner', args: { steps: [{ name: 'page_ask' }] } }] }, { text: 'ok' });
    const s = rt.createSession();
    await s.send('Go.').done;
    for (const id of ['b1', 'b2', 'b3']) expect(rt.store.listToolCalls(s.id).find((c) => c.id === id)?.result).toContain(':unavailable');
  });
});
