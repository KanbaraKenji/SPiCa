// The author kit's own MCP client (check.mjs, preview.mjs) treats long tool calls
// the way Spica does: progress keeps a call alive, a timeout cancels it at the server.
// Times are scaled down: the kit's 2 s timeout stands for Spica's 60 s.
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const SERVER = `
const cancelled = [];
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const jobs = new Map();
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'notifications/cancelled') {
    cancelled.push(m.params);
    const j = jobs.get(m.params.requestId);
    if (j) { clearInterval(j.tick); clearTimeout(j.done); }
    return;
  }
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 'k' } } });
  if (m.method === 'tools/list') return send({ id: m.id, result: { tools: [] } });
  const a = m.params.arguments;
  if (m.params.name === 'cancelled') return send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(cancelled) }] } });
  const token = m.params._meta && m.params._meta.progressToken;
  let n = 0;
  const tick = a.every ? setInterval(() => send({ method: 'notifications/progress', params: { progressToken: token, progress: ++n } }), a.every) : undefined;
  const done = setTimeout(() => { clearInterval(tick); send({ id: m.id, result: { content: [{ type: 'text', text: 'done ' + n }] } }); }, a.ms);
  jobs.set(m.id, { tick, done });
});
`;

type Kit = {
  StdioClient: new (o: { command: string; args: string[]; timeoutMs?: number; maxCallMs?: number }) => {
    initialize(): Promise<unknown>;
    callToolRaw(name: string, args: object): Promise<{ content: { text: string }[] }>;
    close(): Promise<void>;
  };
};
const kitFile = new URL('../../../skills/spica-plugin-author/scripts/lib/mcp.mjs', import.meta.url).href;

describe('author kit MCP client', () => {
  it('a call that reports progress outlives the timeout; one that does not is cancelled at the server', async () => {
    const { StdioClient } = (await import(kitFile)) as Kit;
    const c = new StdioClient({ command: process.execPath, args: ['-e', SERVER], timeoutMs: 2000 });
    try {
      await c.initialize();
      expect((await c.callToolRaw('long', { ms: 3000, every: 200 })).content[0]!.text).toMatch(/^done \d+$/);
      await expect(c.callToolRaw('long', { ms: 4000 })).rejects.toThrow(/超过 2 秒没有回应，也没有报进度/);
      const cancelled = JSON.parse((await c.callToolRaw('cancelled', {})).content[0]!.text) as { requestId: number }[];
      expect(cancelled).toEqual([expect.objectContaining({ requestId: expect.any(Number) })]);
    } finally {
      await c.close();
    }
  });

  it('progress cannot keep a call alive past the overall limit', async () => {
    const { StdioClient } = (await import(kitFile)) as Kit;
    const c = new StdioClient({ command: process.execPath, args: ['-e', SERVER], timeoutMs: 2000, maxCallMs: 3000 });
    try {
      await c.initialize();
      await expect(c.callToolRaw('long', { ms: 8000, every: 200 })).rejects.toThrow(/超过 3 秒还没做完/);
    } finally {
      await c.close();
    }
  });
});
