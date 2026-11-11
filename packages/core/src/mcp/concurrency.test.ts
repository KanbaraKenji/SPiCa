// A server declared with concurrency: tool calls wait their turn, in order, and waiting
// counts toward neither timeout. Times are scaled down; windows that would fail falsely
// on a stall are kept at 1.2 s or more (busy machines).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { makeRuntime, startGateway } from '../testing/helpers.ts';
import { McpStdioClient, type McpServerConfig } from './client.ts';

vi.setConfig({ testTimeout: 30_000 });

// `work` runs for `ms`; `stats` tells how many calls were inside at once and in which order
// they arrived; `crash` makes the server exit after `ms`.
const SERVER = `
let busy = 0, most = 0;
const order = [];
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 'one' } } });
  if (m.method === 'tools/list') return send({ id: m.id, result: { tools: [{ name: 'work', inputSchema: { type: 'object' } }, { name: 'stats', inputSchema: { type: 'object' } }] } });
  const { name, arguments: a } = m.params;
  if (name === 'stats') return send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ most, order }) }] } });
  if (name === 'crash') return setTimeout(() => process.exit(3), a.ms);
  busy++;
  most = Math.max(most, busy);
  order.push(a.label);
  setTimeout(() => { busy--; send({ id: m.id, result: { content: [{ type: 'text', text: 'done ' + a.label }] } }); }, a.ms);
});
`;

const start = async (opts: Partial<McpServerConfig> = {}) => {
  // connect with the default timeout (a cold start may be slow), then apply the limits under test
  const c = new McpStdioClient({ name: 'one', command: process.execPath, args: ['-e', SERVER] });
  await c.connect();
  Object.assign(c.config, opts);
  return c;
};
const stats = async (c: McpStdioClient) => JSON.parse((await c.callTool('stats', {})).content) as { most: number; order: string[] };

describe('MCP tool calls with concurrency', () => {
  it('without a limit, calls overlap in the server (the behaviour before)', async () => {
    const c = await start();
    try {
      await Promise.all([c.callTool('work', { ms: 600, label: 'a' }), c.callTool('work', { ms: 600, label: 'b' })]);
      expect((await stats(c)).most).toBe(2);
    } finally {
      await c.close();
    }
  });

  it('concurrency 1: calls run one after another in arrival order, and waiting does not time out', async () => {
    // each call takes 1.2 s; the third waits 2.4 s, longer than both limits
    const c = await start({ concurrency: 1, timeoutMs: 2000, maxCallMs: 2000 });
    try {
      const calls = ['a', 'b', 'c'].map((label) => c.callTool('work', { ms: 1200, label }));
      await new Promise((r) => setTimeout(r, 200));
      expect(c.waiting).toBe(2);
      expect(await Promise.all(calls)).toEqual(['a', 'b', 'c'].map((l) => ({ content: `done ${l}`, isError: false })));
      expect(c.waiting).toBe(0);
      expect(await stats(c)).toEqual({ most: 1, order: ['a', 'b', 'c'] });
    } finally {
      await c.close();
    }
  });

  it('concurrency 2 lets two in at a time', async () => {
    const c = await start({ concurrency: 2 });
    try {
      await Promise.all(['a', 'b', 'c', 'd'].map((label) => c.callTool('work', { ms: 400, label })));
      expect((await stats(c)).most).toBe(2);
    } finally {
      await c.close();
    }
  });

  it('a call stopped while waiting leaves the queue and never reaches the server', async () => {
    const c = await start({ concurrency: 1 });
    try {
      const first = c.callTool('work', { ms: 800, label: 'a' });
      const ac = new AbortController();
      const second = c.callTool('work', { ms: 100, label: 'b' }, ac.signal);
      const third = c.callTool('work', { ms: 100, label: 'c' });
      setTimeout(() => ac.abort(), 100);
      await expect(second).rejects.toThrow(/aborted/);
      await Promise.all([first, third]);
      expect((await stats(c)).order).toEqual(['a', 'c']);
    } finally {
      await c.close();
    }
  });

  it('when the server crashes or is stopped, waiting calls fail with the same reason', async () => {
    const c = await start({ concurrency: 1 });
    const running = c.callTool('crash', { ms: 300 });
    const waiting = c.callTool('work', { ms: 100, label: 'b' });
    await expect(running).rejects.toThrow(/exited/);
    await expect(waiting).rejects.toThrow(/exited/);
    expect(c.waiting).toBe(0);

    const d = await start({ concurrency: 1 });
    const busy = d.callTool('work', { ms: 2000, label: 'a' });
    const queued = d.callTool('work', { ms: 100, label: 'b' });
    await new Promise((r) => setTimeout(r, 100));
    const closed = d.close();
    await expect(busy).rejects.toThrow(/disconnected/);
    await expect(queued).rejects.toThrow(/disconnected/);
    await closed;
  });
});

describe('concurrency across conversations and plugin pages', () => {
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = await startGateway();
  });
  afterEach(async () => {
    await gw.stop();
  });

  it('two conversations and a plugin page share one queue; the later ones do not time out', async () => {
    gw.enqueue(
      { toolCalls: [{ id: 'w1', name: 'one__work', args: { ms: 1200, label: 'chat-1' } }] },
      { toolCalls: [{ id: 'w2', name: 'one__work', args: { ms: 1200, label: 'chat-2' } }] },
      { text: 'done' },
      { text: 'done' },
    );
    const rt = makeRuntime(gw);
    try {
      const config: McpServerConfig = { name: 'one', command: process.execPath, args: ['-e', SERVER], concurrency: 1 };
      await rt.connectMcp(config, { source: 'plugin:one' });
      Object.assign(config, { timeoutMs: 2000, maxCallMs: 2000 }); // after connect; the client keeps this object
      const a = rt.createSession();
      const b = rt.createSession();
      const runs = [a.send('first').done, b.send('second').done];
      await new Promise((r) => setTimeout(r, 300));
      const page = rt.callPluginTool('one', 'work', { ms: 1200, label: 'page' });
      const done = await Promise.all(runs);
      expect(done.map((x) => x.reason)).not.toContain('error');
      expect(await page).toMatchObject({ isError: false, content: 'done page' });
      for (const s of [a, b]) expect(JSON.stringify(s.messages())).toMatch(/done chat-\d/);
      const st = JSON.parse((await rt.callPluginTool('one', 'stats', {})).content) as { most: number; order: string[] };
      expect(st.most).toBe(1);
      expect(st.order).toHaveLength(3);
    } finally {
      await rt.close();
    }
  });

  it('deleting a conversation whose call is waiting takes the call out of the queue', async () => {
    gw.enqueue({ toolCalls: [{ id: 'w1', name: 'one__work', args: { ms: 100, label: 'deleted-chat' } }] });
    const rt = makeRuntime(gw);
    try {
      await rt.connectMcp({ name: 'one', command: process.execPath, args: ['-e', SERVER], concurrency: 1 }, { source: 'plugin:one' });
      const page = rt.callPluginTool('one', 'work', { ms: 1500, label: 'page' }); // holds the turn
      await new Promise((r) => setTimeout(r, 200));
      const s = rt.createSession();
      const run = s.send('go').done;
      await new Promise((r) => setTimeout(r, 400)); // its call is waiting now
      await rt.deleteSession(s.id);
      await run.catch(() => undefined);
      expect(await page).toMatchObject({ isError: false });
      const st = JSON.parse((await rt.callPluginTool('one', 'stats', {})).content) as { order: string[] };
      expect(st.order).toEqual(['page']);
    } finally {
      await rt.close();
    }
  });
});
