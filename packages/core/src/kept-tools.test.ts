// A tool allowed on its card (始终允许) when a hook asks first and offers to keep it (a user MCP service's tool):
// that tool runs without asking for the rest of the conversation (its sub-agents too); another tool, another
// conversation, a guard's confirmation and 允许一次 still ask.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway } from './testing/helpers.ts';
import { allowedFoldersTool } from './tools/folder-tools.ts';
import type { Tool } from './tools/types.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
beforeEach(async () => {
  gw = await startGateway();
});
afterEach(async () => {
  await gw.stop();
});

const tool = (name: string, ran: string[], extra: Partial<Tool> = {}): Tool => ({
  spec: { name, description: '', inputSchema: { type: 'object' } },
  execute: async () => (ran.push(name), { content: `${name} done` }),
  ...extra,
});

function setup() {
  const rt = makeRuntime(gw, { tools: [allowedFoldersTool] });
  const events = captureEvents(rt);
  const ran: string[] = [];
  rt.tools.register(tool('lab__temp', ran), 'mcp:lab');
  rt.tools.register(tool('lab__light', ran), 'mcp:lab');
  rt.tools.register(tool('lab__send', ran, { irreversible: true }), 'mcp:lab');
  rt.tools.register(tool('web__read', ran, { untrusted: 'mcp' }), 'mcp:web');
  // as the user MCP services' hook: every lab tool asks, and may be kept under its own key
  rt.hooks.register('mcp:lab', { beforeTool: (c) => (c.name.startsWith('lab__') ? { action: 'confirm', reason: c.name, keep: `mcp:x:${c.name}` } : undefined) });
  return { rt, events, ran };
}

/** Asks for `name` (id), answering its card. */
async function call(s: { send(t: string): { done: Promise<{ reason: string }> }; confirm(id: string, ok: boolean, o?: { always?: boolean }): Promise<unknown> }, name: string, id: string) {
  gw.enqueue({ toolCalls: [{ id, name, args: {} }] }, { text: 'ok' });
  return (await s.send(`call ${name}`).done).reason;
}

describe('始终允许 on a tool a hook asks for', () => {
  it('the same tool runs without asking afterwards in this conversation; another tool and another conversation still ask', async () => {
    const { rt, events, ran } = setup();
    const s = rt.createSession();
    expect(await call(s, 'lab__temp', 't1')).toBe('awaiting_confirm');
    expect(events.find((e) => e.type === 'confirm.request')).toMatchObject({ callId: 't1', keepTool: 'mcp:x:lab__temp' });
    await (await s.confirm('t1', true, { always: true }))!;
    expect(ran).toEqual(['lab__temp']);
    const told = s.messages().flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.toolUseId === 't1');
    expect(told && 'content' in told ? told.content : '').toContain('runs without asking from now on in this conversation');

    expect(await call(s, 'lab__temp', 't2')).toBe('completed');
    expect(ran).toEqual(['lab__temp', 'lab__temp']);
    expect(await call(s, 'lab__light', 'l1')).toBe('awaiting_confirm');
    await s.confirm('l1', false);
    await s.settled();

    const other = rt.createSession();
    expect(await call(other, 'lab__temp', 'o1')).toBe('awaiting_confirm');
    // kept with the conversation (there after the app starts again)
    expect(rt.store.getSession(s.id)!.config.keptTools).toEqual([{ key: 'mcp:x:lab__temp', tool: 'lab__temp' }]);
    expect(rt.store.getSession(other.id)!.config.keptTools).toBeUndefined();
  });

  it('允许一次 keeps nothing', async () => {
    const { rt, ran } = setup();
    const s = rt.createSession();
    expect(await call(s, 'lab__temp', 't1')).toBe('awaiting_confirm');
    await (await s.confirm('t1', true))!;
    expect(ran).toEqual(['lab__temp']);
    expect(await call(s, 'lab__temp', 't2')).toBe('awaiting_confirm');
  });

  it('a sub-agent: what the conversation kept counts there, and what it keeps is the conversation’s', async () => {
    const { rt } = setup();
    const s = rt.createSession();
    expect(await call(s, 'lab__temp', 't1')).toBe('awaiting_confirm');
    await (await s.confirm('t1', true, { always: true }))!;
    const child = rt.createSession({ parentId: s.id });
    expect(await call(child, 'lab__temp', 'c1')).toBe('completed');
    expect(await call(child, 'lab__light', 'c2')).toBe('awaiting_confirm');
    await (await child.confirm('c2', true, { always: true }))!;
    expect(s.keptTools().map((k) => k.tool)).toEqual(['lab__temp', 'lab__light']);
  });

  it('not offered, and not passed, when the guard asks (outside content in the turn) or the call cannot be undone', async () => {
    const { rt, events } = setup();
    const s = rt.createSession();
    // a tool declared irreversible (an MCP tool with destructiveHint): the card offers no 始终允许
    expect(await call(s, 'lab__send', 's1')).toBe('awaiting_confirm');
    expect(events.find((e) => e.type === 'confirm.request' && e.callId === 's1')).not.toHaveProperty('keepTool');
    await (await s.confirm('s1', true, { always: true }))!;
    expect(s.keptTools()).toEqual([]);

    // kept, then outside content comes into the turn: the guard's confirmation still goes to the user
    s.keepTool('mcp:x:lab__send', 'lab__send');
    gw.enqueue({ toolCalls: [{ id: 'r1', name: 'web__read', args: {} }] }, { toolCalls: [{ id: 's2', name: 'lab__send', args: {} }] }, { text: 'ok' });
    expect((await s.send('read then send').done).reason).toBe('awaiting_confirm');
    expect(s.pending()[0]).toMatchObject({ toolName: 'lab__send', cause: 'untrusted_turn' });
    expect(s.pending()[0]).not.toHaveProperty('keepTool');
  });

  it('a hook marking the call irreversible: no 始终允许 either', async () => {
    const { rt, events } = setup();
    rt.hooks.register('mark', { beforeTool: (c) => (c.name === 'lab__temp' ? { action: 'confirm', irreversible: true, keep: 'mcp:x:lab__temp' } : undefined) });
    const s = rt.createSession();
    expect(await call(s, 'lab__temp', 't1')).toBe('awaiting_confirm');
    expect(events.find((e) => e.type === 'confirm.request')).not.toHaveProperty('keepTool');
  });

  it('another hook asking for the same call is never waived by the key', async () => {
    const { rt } = setup();
    rt.hooks.register('bank', { beforeTool: (c) => (c.name === 'lab__temp' ? { action: 'confirm', reason: 'the bank asks too' } : undefined) });
    const s = rt.createSession();
    s.keepTool('mcp:x:lab__temp', 'lab__temp');
    expect(await call(s, 'lab__temp', 't1')).toBe('awaiting_confirm');
    expect(s.pending()[0]).not.toHaveProperty('keepTool');
  });

  it('taken back with allowed_folders when the user asks (no card for that): the next call asks again; list shows it; a sub-agent’s call acts on the conversation', async () => {
    const { rt } = setup();
    const s = rt.createSession();
    for (const [name, id] of [['lab__temp', 't1'], ['lab__light', 'l1']] as const) {
      expect(await call(s, name, id)).toBe('awaiting_confirm');
      await (await s.confirm(id, true, { always: true }))!;
    }
    const result = (id: string) => {
      for (const m of s.messages()) for (const b of m.content) if (b.type === 'tool_result' && b.toolUseId === id) return b.content;
      return '';
    };
    gw.enqueue({ toolCalls: [{ id: 'a1', name: 'allowed_folders', args: { action: 'list' } }] }, { text: 'two' });
    await s.send('what is allowed?').done;
    expect(result('a1')).toContain('- lab__temp\n- lab__light');
    // as the card says it
    gw.enqueue({ toolCalls: [{ id: 'a2', name: 'allowed_folders', args: { action: 'revoke', tool: 'lab · temp' } }] }, { text: 'taken back' });
    expect((await s.send('取消刚才的始终允许').done).reason).toBe('completed');
    expect(result('a2')).toContain('Taken back (tools):\n- lab__temp');
    expect(await call(s, 'lab__temp', 't2')).toBe('awaiting_confirm');
    await s.confirm('t2', false);
    await s.settled();
    expect(await call(s, 'lab__light', 'l2')).toBe('completed');
    // nothing by that name: an error, and what there is
    gw.enqueue({ toolCalls: [{ id: 'a3', name: 'allowed_folders', args: { action: 'revoke', tool: 'lab__temp' } }] }, { text: 'none' });
    await s.send('again').done;
    expect(result('a3')).toContain('is not among the tools allowed on a card');
    // a service's name, from a sub-agent: the whole conversation
    const child = rt.createSession({ parentId: s.id });
    gw.enqueue({ toolCalls: [{ id: 'c1', name: 'allowed_folders', args: { action: 'revoke', tool: 'lab' } }] }, { text: 'ok' });
    await child.send('ask me for lab again').done;
    expect(s.keptTools()).toEqual([]);
    expect(rt.store.getSession(s.id)!.config.keptTools).toEqual([]);
  });

  it('allow once after taking back: the model is told it was this once', async () => {
    const { rt } = setup();
    const s = rt.createSession();
    expect(await call(s, 'lab__temp', 't1')).toBe('awaiting_confirm');
    await (await s.confirm('t1', true))!;
    const told = s.messages().flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.toolUseId === 't1');
    expect(told && 'content' in told ? told.content : '').toContain('lab__temp this once');
  });
});
