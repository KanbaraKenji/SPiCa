// Long tool calls: progress notifications keep a call alive, a timeout tells the server to stop.
// Times are scaled down 40x: "60 s" is 1.5 s, "3 minutes" is 4.5 s, "every 10 s" is every 250 ms.
// Windows where a stall would cause a false failure are kept at 1.5 s or more (busy machines).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { makeRuntime, startGateway } from '../testing/helpers.ts';
import { McpStdioClient, type McpServerConfig } from './client.ts';

vi.setConfig({ testTimeout: 30_000 });

// A server whose `long` tool works for `ms`, sending progress every `every` ms when the
// call carries a progress token. It records what it saw and answers `seen` with it.
const SERVER = `
const seen = { cancelled: [], tokens: [], finished: [] };
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const jobs = new Map();
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'notifications/cancelled') {
    seen.cancelled.push(msg.params);
    const job = jobs.get(msg.params.requestId);
    if (job?.stubborn) return; // keeps working and answers anyway
    if (job) { clearInterval(job.tick); clearTimeout(job.done); jobs.delete(msg.params.requestId); }
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'long' } } });
  if (msg.method === 'tools/list') return send({ id: msg.id, result: { tools: [{ name: 'long', inputSchema: { type: 'object' } }, { name: 'seen', inputSchema: { type: 'object' } }] } });
  if (msg.method !== 'tools/call') return send({ id: msg.id, error: { code: -32601, message: 'no' } });
  const { name, arguments: a } = msg.params;
  if (name === 'seen') return send({ id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(seen) }] } });
  const token = msg.params._meta?.progressToken;
  seen.tokens.push(token ?? null);
  let n = 0;
  const job = { stubborn: !!a.stubborn };
  if (token !== undefined && a.every) job.tick = setInterval(() => send({ method: 'notifications/progress', params: { progressToken: a.otherToken ?? token, progress: ++n, message: 'step ' + n } }), a.every);
  job.done = setTimeout(() => { clearInterval(job.tick); jobs.delete(msg.id); seen.finished.push(msg.id); send({ id: msg.id, result: { content: [{ type: 'text', text: 'all ' + n + ' steps done' + (a.label ? ' (' + a.label + ')' : '') }] } }); }, a.ms);
  jobs.set(msg.id, job);
});
`;

// Start with the default timeout (a cold process on a busy machine can be slow
// to answer initialize), then use the short ones for the calls under test.
const start = async (opts: { timeoutMs?: number; maxCallMs?: number } = {}) => {
  const c = new McpStdioClient({ name: 'long', command: process.execPath, args: ['-e', SERVER] });
  await c.connect();
  Object.assign(c.config, opts);
  return c;
};
const seen = async (c: McpStdioClient) =>
  JSON.parse((await c.callTool('seen', {})).content) as { cancelled: { requestId: number; reason?: string }[]; tokens: unknown[]; finished: number[] };

describe('long MCP tool calls', () => {
  it('a tool that reports progress every "10 s" for "3 minutes" finishes under a "60 s" timeout', async () => {
    const c = await start({ timeoutMs: 1500 });
    try {
      const r = await c.callTool('long', { ms: 4500, every: 250 });
      expect(r).toEqual({ content: expect.stringMatching(/^all \d+ steps done$/), isError: false });
      expect((await seen(c)).tokens).toEqual([expect.anything()]);
    } finally {
      await c.close();
    }
  });

  it('without progress the call times out and the server is told to stop', async () => {
    const c = await start({ timeoutMs: 300 });
    try {
      await expect(c.callTool('long', { ms: 1500 })).rejects.toThrow(/did not answer tools\/call within 0.3 s/);
      await new Promise((r) => setTimeout(r, 1500));
      const s = await seen(c);
      expect(s.cancelled).toEqual([{ requestId: expect.any(Number), reason: expect.stringMatching(/timed out/) }]);
      expect(s.finished).toEqual([]); // the server stopped instead of finishing in vain
    } finally {
      await c.close();
    }
  });

  it('progress for another token does not keep the call alive', async () => {
    const c = await start({ timeoutMs: 300 });
    try {
      await expect(c.callTool('long', { ms: 1500, every: 50, otherToken: 'someone-else' })).rejects.toThrow(/within 0.3 s/);
    } finally {
      await c.close();
    }
  });

  it('progress cannot keep a call alive past the overall limit', async () => {
    const c = await start({ timeoutMs: 1500, maxCallMs: 3000 });
    try {
      const t0 = Date.now();
      await expect(c.callTool('long', { ms: 10_000, every: 100 })).rejects.toThrow(/did not finish tools\/call within 3 s/);
      expect(Date.now() - t0).toBeLessThan(6000);
      await new Promise((r) => setTimeout(r, 200));
      expect((await seen(c)).cancelled).toEqual([{ requestId: expect.any(Number), reason: expect.stringMatching(/timed out/) }]);
    } finally {
      await c.close();
    }
  });

  it('an answer that arrives after the timeout is not taken for the next call', async () => {
    const c = await start({ timeoutMs: 300 });
    try {
      // the server ignores the cancellation and answers at 600 ms
      await expect(c.callTool('long', { ms: 600, stubborn: true, label: 'first' })).rejects.toThrow(/within 0.3 s/);
      c.config.timeoutMs = 5000;
      // the next call is still running when the late answer to the first one arrives
      expect(await c.callTool('long', { ms: 800, label: 'second' })).toEqual({ content: 'all 0 steps done (second)', isError: false });
      expect((await seen(c)).finished).toHaveLength(2);
    } finally {
      await c.close();
    }
  });

  it('reports each progress notification of the call to its listener', async () => {
    const c = await start({ timeoutMs: 5000 });
    try {
      const reports: unknown[] = [];
      await c.callTool('long', { ms: 1000, every: 100 }, undefined, (p) => reports.push(p));
      expect(reports.slice(0, 3)).toEqual([
        { progress: 1, message: 'step 1' },
        { progress: 2, message: 'step 2' },
        { progress: 3, message: 'step 3' },
      ]);
    } finally {
      await c.close();
    }
  });

  it('a huge limit is not taken for "fire at once" (Node caps setTimeout at about 24 days)', async () => {
    const c = await start({ timeoutMs: 1e12, maxCallMs: 1e15 });
    try {
      expect(await c.callTool('long', { ms: 300 })).toEqual({ content: 'all 0 steps done', isError: false });
    } finally {
      await c.close();
    }
  });

  it('stopping a long call tells the server, and a late answer is ignored', async () => {
    const c = await start({ timeoutMs: 5000 });
    try {
      const ac = new AbortController();
      const p = c.callTool('long', { ms: 1500, every: 100 }, ac.signal);
      setTimeout(() => ac.abort(), 250);
      await expect(p).rejects.toThrow(/aborted/);
      const s = await seen(c);
      expect(s.cancelled).toEqual([{ requestId: expect.any(Number), reason: 'user interrupted' }]);
      expect(await c.callTool('long', { ms: 50 })).toMatchObject({ isError: false }); // the client still works
    } finally {
      await c.close();
    }
  });
});

describe('long MCP tool calls in a conversation', () => {
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = await startGateway();
  });
  afterEach(async () => {
    await gw.stop();
  });

  it('the model calls a tool that reports progress for longer than the timeout and gets its result', async () => {
    gw.enqueue({ toolCalls: [{ id: 'l1', name: 'long__long', args: { ms: 4500, every: 250 } }] }, { text: 'done' });
    const rt = makeRuntime(gw);
    try {
      const config: McpServerConfig = { name: 'long', command: process.execPath, args: ['-e', SERVER] };
      await rt.connectMcp(config);
      config.timeoutMs = 1500; // after connect: a cold start may be slow; the client keeps this object
      const s = rt.createSession();
      const r = await s.send('fetch everything').done;
      expect(r.reason).not.toBe('error');
      expect(JSON.stringify(s.messages()[2]!.content)).toMatch(/all \d+ steps done/);
      expect(rt.store.listTraces().find((t) => t.kind === 'mcp')).toMatchObject({ target: 'long', status: 'ok' });
    } finally {
      await rt.close();
    }
  });
});
