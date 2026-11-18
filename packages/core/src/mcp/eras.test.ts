// The version probe (protocol 'auto'): server/discover first (MCP 2026-07-28), initialize for older servers.
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { McpStdioClient, MODERN_PROTOCOL } from './client.ts';

vi.setConfig({ testTimeout: 30_000 });

const script = fileURLToPath(new URL('../testing/fake-mcp-eras.mjs', import.meta.url));

/** A client for the fake of that kind, with what it was sent (one parsed line each). */
function client(kind: string, extra: { discoverTimeoutMs?: number; protocol?: 'auto' | 'legacy' } = {}) {
  const sent: { method: string; meta: Record<string, unknown> | null }[] = [];
  let buf = '';
  const c = new McpStdioClient({
    name: 'eras',
    command: process.execPath,
    args: [script, kind],
    protocol: 'auto',
    ...extra,
    stderrLog: (chunk) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          sent.push(JSON.parse(line));
        } catch {
          // not ours
        }
      }
    },
  });
  return { c, sent };
}

describe('MCP version probe', () => {
  it('a server that speaks 2026-07-28: no handshake, the version in every request', async () => {
    const { c, sent } = client('modern');
    await c.connect();
    expect(c.protocolVersion).toBe(MODERN_PROTOCOL);
    expect(c.serverInfo).toEqual({ name: 'eras', version: '2.0.0' });
    expect((await c.listTools()).map((t) => t.name)).toEqual(['hello']);
    expect(await c.callTool('hello', { who: 'ALEX' })).toEqual({ content: 'hello ALEX', isError: false });
    await c.close();
    expect(sent.map((s) => s.method)).toEqual(['server/discover', 'tools/list', 'tools/call']);
    // the call's own _meta (its progress token) is kept beside the version's
    expect(sent[2]!.meta).toMatchObject({ 'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL, 'io.modelcontextprotocol/clientInfo': { name: 'spica' }, progressToken: expect.any(Number) });
  });

  it('an older server that refuses server/discover: initialize, as before', async () => {
    const { c, sent } = client('refuses');
    await c.connect();
    expect(c.protocolVersion).toBe('2025-06-18');
    expect(await c.callTool('hello', { who: 'x' })).toEqual({ content: 'hello x', isError: false });
    await c.close();
    expect(sent.map((s) => s.method)).toEqual(['server/discover', 'initialize', 'notifications/initialized', 'tools/call']);
    expect(sent[3]!.meta).not.toHaveProperty(['io.modelcontextprotocol/protocolVersion']);
  });

  it('an older server that does not answer: initialize after the wait, and it is not told to cancel', async () => {
    const { c, sent } = client('silent', { discoverTimeoutMs: 300 });
    await c.connect();
    expect(c.protocolVersion).toBe('2025-06-18');
    await c.close();
    expect(sent.map((s) => s.method)).toEqual(['server/discover', 'initialize', 'notifications/initialized']);
  });

  it('a newer server without 2026-07-28: an error that names its versions (no fallback)', async () => {
    const { c, sent } = client('future');
    await expect(c.connect()).rejects.toThrow(/2027-01-01/);
    await c.close();
    expect(sent.map((s) => s.method)).toEqual(['server/discover']);
  });

  it('input_required from a tool: said as an error, nothing hangs', async () => {
    const { c } = client('needs');
    await c.connect();
    const r = await c.callTool('hello', {});
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/elicitation\/create/);
    await c.close();
  });

  it('legacy (the default) never sends server/discover', async () => {
    const { c, sent } = client('refuses', { protocol: 'legacy' });
    await c.connect();
    await c.close();
    expect(sent[0]!.method).toBe('initialize');
  });
});
