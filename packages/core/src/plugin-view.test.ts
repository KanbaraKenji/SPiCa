// A plugin's own view calls that plugin's tools directly: no model, no session
// history, irreversible actions confirmed by the user, a small limiter.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentApi } from './api.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, until } from './testing/helpers.ts';
import type { Tool } from './tools/types.ts';
import type { Runtime } from './runtime.ts';

let gw: FakeGateway;
beforeEach(async () => {
  gw = await startGateway();
});
afterEach(async () => {
  await gw.stop();
});

function plugin(rt: Runtime, ran: string[], opts: { slowMs?: number } = {}) {
  let active = 0;
  const stats = { maxActive: 0 };
  const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
    spec: { name, description: name, inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    execute: async (input, ctx) => {
      active++;
      stats.maxActive = Math.max(stats.maxActive, active);
      if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));
      active--;
      ran.push(`${name}:${String(input.id ?? '')}:${ctx.initiator ?? ''}${ctx.confirmedBy ? `:${ctx.confirmedBy}` : ''}`);
      return { content: JSON.stringify({ note: `note ${String(input.id ?? '')}` }) };
    },
    ...extra,
  });
  rt.tools.register(tool('notes__read_note'), 'plugin:notes');
  rt.tools.register(tool('notes__delete_note', { irreversible: true }), 'plugin:notes');
  rt.tools.register(tool('mail__send'), 'plugin:mail');
  // a second server of the notes plugin, named differently
  rt.tools.register(tool('notes-sync__push', { irreversible: true }), 'plugin:notes');
  return stats;
}

describe('callPluginTool', () => {
  it('runs the plugin\'s own tool and returns its text as is, outside any session', async () => {
    const rt = makeRuntime(gw);
    const ran: string[] = [];
    plugin(rt, ran);
    const api = createAgentApi(rt);
    const s = rt.createSession();
    const r = await api.callPluginTool!('notes', 'read_note', { id: 'a' }, { sessionId: s.id });
    expect(r).toEqual({ content: '{"note":"note a"}', isError: false });
    expect(ran).toEqual(['notes__read_note:a:view:notes']);
    expect(s.messages()).toEqual([]); // nothing in the history
    expect(gw.requests).toHaveLength(0); // no model
    // only that plugin's tools
    await expect(api.callPluginTool!('notes', 'mail__send', {})).rejects.toThrow(/has no tool/);
    await expect(api.callPluginTool!('notes', 'nope', {})).rejects.toThrow(/has no tool/);
    await expect(api.callPluginTool!('notes', 'read_note', {}, { sessionId: 'missing' })).rejects.toThrow(/unknown session/);
  });

  it('an irreversible tool waits for the user (cause plugin_view); no runs nothing; hooks still apply', async () => {
    const rt = makeRuntime(gw);
    const events = captureEvents(rt);
    const ran: string[] = [];
    plugin(rt, ran);
    const api = createAgentApi(rt);
    const top = rt.top();
    const pending = api.callPluginTool!('notes', 'delete_note', { id: 'x' });
    await until(() => events.some((e) => e.type === 'confirm.request'));
    const ask = events.find((e) => e.type === 'confirm.request')!;
    expect(ask).toMatchObject({ sessionId: top.id, name: 'notes__delete_note', input: { id: 'x' }, cause: 'plugin_view' });
    expect(ran).toEqual([]);
    await api.confirm(top.id, ask.type === 'confirm.request' ? ask.callId : '', false);
    expect(await pending).toMatchObject({ isError: true, declined: true });
    expect(ran).toEqual([]);

    const again = api.callPluginTool!('notes', 'delete_note', { id: 'y' });
    await until(() => events.filter((e) => e.type === 'confirm.request').length === 2);
    const ask2 = events.filter((e) => e.type === 'confirm.request')[1]!;
    await api.confirm(top.id, ask2.type === 'confirm.request' ? ask2.callId : '', true);
    expect(await again).toMatchObject({ isError: false });
    expect(ran).toEqual(['notes__delete_note:y:view:notes:user']);
    expect(events.filter((e) => e.type === 'confirm.resolved').map((e) => (e.type === 'confirm.resolved' ? e.approved : null))).toEqual([false, true]);

    rt.hooks.register('policy', { beforeTool: (c) => (c.name === 'notes__read_note' ? { action: 'deny', reason: 'not today' } : undefined) });
    expect(await api.callPluginTool!('notes', 'read_note', {})).toEqual({ content: 'Blocked: not today', isError: true });
  });

  it('full tool names of any of the plugin servers work; confirmed: true runs without asking again', async () => {
    const rt = makeRuntime(gw);
    const events = captureEvents(rt);
    const ran: string[] = [];
    plugin(rt, ran);
    expect((await rt.callPluginTool('notes', 'notes__read_note', { id: 'f' })).isError).toBe(false);
    expect(await rt.callPluginTool('notes', 'notes-sync__push', { id: 'p' }, { confirmed: true })).toMatchObject({ isError: false });
    expect(ran).toEqual(['notes__read_note:f:view:notes', 'notes-sync__push:p:view:notes:view']);
    expect(events.some((e) => e.type === 'confirm.request')).toBe(false);
    // confirmed: false never waits: it says a confirmation is needed and runs nothing
    expect(await rt.callPluginTool('notes', 'notes__delete_note', { id: 'q' }, { confirmed: false })).toMatchObject({ isError: true, needsConfirmation: true });
    expect(await rt.callPluginTool('notes', 'read_note', { id: 'r' }, { confirmed: false })).toMatchObject({ isError: false }); // nothing to confirm
    expect(ran).toEqual(['notes__read_note:f:view:notes', 'notes-sync__push:p:view:notes:view', 'notes__read_note:r:view:notes']);
    expect(events.some((e) => e.type === 'confirm.request')).toBe(false);
    // a full name that belongs to another plugin is still refused
    await expect(rt.callPluginTool('notes', 'mail__send', {}, { confirmed: true })).rejects.toThrow(/has no tool/);
  });

  it('works on a fresh install with no model configured, and creates no session', async () => {
    const rt = makeRuntime(gw, { providers: [], defaults: { providerId: 'none', model: 'none', maxTokens: 64 } });
    const events = captureEvents(rt);
    const ran: string[] = [];
    plugin(rt, ran);
    expect(await rt.callPluginTool('notes', 'read_note', { id: 'n' })).toMatchObject({ isError: false });
    // a card can still be shown and answered without any session
    const api = createAgentApi(rt);
    const p = api.callPluginTool!('notes', 'delete_note', { id: 'd' });
    await until(() => events.some((e) => e.type === 'confirm.request'));
    const ask = events.find((e) => e.type === 'confirm.request')!;
    expect(ask.sessionId).toBe('');
    await api.confirm('', ask.type === 'confirm.request' ? ask.callId : '', true);
    expect(await p).toMatchObject({ isError: false });
    expect(ran).toEqual(['notes__read_note:n:view:notes', 'notes__delete_note:d:view:notes:user']);
    expect(rt.sessions()).toEqual([]);
  });

  it('calls of one plugin share a small limiter', async () => {
    const rt = makeRuntime(gw);
    const ran: string[] = [];
    const stats = plugin(rt, ran, { slowMs: 40 });
    await Promise.all(Array.from({ length: 10 }, (_, i) => rt.callPluginTool('notes', 'read_note', { id: String(i) })));
    expect(ran).toHaveLength(10);
    expect(stats.maxActive).toBeLessThanOrEqual(4);
  });
});
