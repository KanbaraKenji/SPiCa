// Services the person adds at a web address: a real core runtime and a small MCP server at 127.0.0.1 (nothing real
// in it). The key goes in a header; why one does not run is a kind the page words.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeHost } from './host.ts';
import { callTool, makeRuntime } from './testing/helpers.ts';
import { UserMcpServers, type UserMcpConfig } from './user-mcp.ts';
// @ts-expect-error a plain .mjs test server
import { startFakeMcpHttp } from '../../core/src/testing/fake-mcp-http.mjs';

vi.setConfig({ testTimeout: 30_000 });

const KEY = 'lab-key-0000-1111-2222';
const open: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of open.splice(0).reverse()) await c();
});

async function setup(era: 'modern' | 'legacy' | 'sse' = 'modern') {
  const f = (await startFakeMcpHttp({ era, key: KEY })) as { url: string; close(): Promise<void> };
  const rt = makeRuntime();
  const log: string[] = [];
  const s = new UserMcpServers({ host: runtimeHost(rt), onLog: (_n, l) => log.push(l) });
  open.push(() => f.close(), () => s.close());
  return { f, rt, s, log };
}

const lab = (url: string, headers?: Record<string, string>): UserMcpConfig => ({ name: 'lab', command: '', args: [], env: {}, url, ...(headers ? { headers } : {}), enabled: true, approval: 'auto' });

describe('services at a web address', () => {
  it.each(['modern', 'legacy', 'sse'] as const)('%s: with the key it runs and its tool answers', async (era) => {
    const { f, rt, s } = await setup(era);
    await s.set([lab(f.url, { authorization: `Bearer ${KEY}` })]);
    expect(s.states()[0]).toMatchObject({ name: 'lab', status: 'running', tools: ['lab__room_temperature'] });
    expect((await callTool(rt, 'lab__room_temperature', { room: 'lab' })).content).toContain('lab: 23.5 °C');
  });

  it('no key: 需要密钥; a wrong one: 密钥无效; the key is in no log or state', async () => {
    const { f, s, log } = await setup();
    await s.set([lab(f.url)]);
    expect(s.states()[0]).toMatchObject({ status: 'failed', problem: { kind: 'needs-key' } });
    await s.set([lab(f.url, { authorization: 'Bearer wrong-key-9999' })]);
    expect(s.states()[0]).toMatchObject({ status: 'failed', problem: { kind: 'bad-key' } });
    expect(JSON.stringify([s.states(), log])).not.toMatch(/wrong-key-9999|lab-key/);
  });

  it('nobody at the address: 无法连接', async () => {
    const { f, s } = await setup();
    const url = f.url;
    await f.close();
    await s.set([lab(url)]);
    expect(s.states()[0]).toMatchObject({ status: 'failed', problem: { kind: 'unreachable' } });
  });
});
