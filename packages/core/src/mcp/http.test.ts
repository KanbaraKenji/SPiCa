// Spica's MCP service over HTTP: token, loopback-only defaults, origin check,
// and the same tools as over stdio.
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBackend } from '../host/backend.ts';
import { connectBackend } from '../host/client.ts';
import { nodePort } from '../host/wire.ts';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, tempDir } from '../testing/helpers.ts';
import { serveMcpHttp, type McpHttpServer } from './http.ts';

// gateways, child processes and local servers start slowly when several full runs share the machine
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;
let srv: McpHttpServer | undefined;
beforeEach(async () => {
  gw = await startGateway();
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  await gw.stop();
  await cleanup();
});

/** Raw HTTP so the test controls every header (fetch would not let us set Host). */
function raw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? 'POST', headers: opts.headers ?? {} }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}
const rpc = (method: string, params: Record<string, unknown> = {}, id: number | null = 1) => JSON.stringify({ jsonrpc: '2.0', ...(id !== null ? { id } : {}), method, params });

describe('MCP over HTTP', () => {
  it('needs the bearer token, then serves the same tools as stdio', async () => {
    gw.onRequest(() => ({ text: 'hello over http' }));
    const rt = makeRuntime(gw, { cwd: dir });
    const events = captureEvents(rt);
    srv = await serveMcpHttp(rt);
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(srv.token.length).toBeGreaterThanOrEqual(40);
    const json = { 'content-type': 'application/json' };
    const auth = { ...json, authorization: `Bearer ${srv.token}` };

    // no token / wrong token: refused before the body is read, nothing runs
    const send = rpc('tools/call', { name: 'spica_run', arguments: { text: 'should not run' } });
    expect((await raw(srv.url, { headers: json, body: send })).status).toBe(401);
    const wrong = await raw(srv.url, { headers: { ...json, authorization: `Bearer ${srv.token.slice(0, -1)}x` }, body: send });
    expect(wrong.status).toBe(401);
    expect(wrong.headers['www-authenticate']).toBe('Bearer');
    expect(gw.requests).toHaveLength(0);
    expect(rt.sessions()).toHaveLength(0);

    const init = JSON.parse((await raw(srv.url, { headers: auth, body: rpc('initialize', { protocolVersion: '2025-06-18' }) })).body) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe('spica');
    expect((await raw(srv.url, { headers: auth, body: rpc('notifications/initialized', {}, null) })).status).toBe(202);
    const list = JSON.parse((await raw(srv.url, { headers: auth, body: rpc('tools/list') })).body) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toContain('spica_export_usage_log');

    const run = JSON.parse((await raw(srv.url, { headers: auth, body: rpc('tools/call', { name: 'spica_run', arguments: { text: 'hi' } }) })).body) as {
      result: { structuredContent: { answer: string } };
    };
    expect(run.result.structuredContent.answer).toBe('hello over http');

    // a batch gets a batch back
    const batch = JSON.parse((await raw(srv.url, { headers: auth, body: `[${rpc('ping', {}, 7)},${rpc('tools/list', {}, 8)}]` })).body) as { id: number }[];
    expect(batch.map((r) => r.id)).toEqual([7, 8]);

    // the token never reaches records or events
    expect(rt.exportTraces()).not.toContain(srv.token);
    expect(JSON.stringify(events)).not.toContain(srv.token);
    expect(rt.exportUsageLog()).not.toContain(srv.token);
  });

  it('refuses browsers on other sites, other methods, other content and oversized bodies', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    srv = await serveMcpHttp(rt, { maxBodyBytes: 1000 });
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${srv.token}` };
    const port = srv.port;
    // DNS rebinding: a page on evil.example resolved to 127.0.0.1
    expect((await raw(srv.url, { headers: { ...auth, origin: 'http://evil.example' }, body: rpc('ping') })).status).toBe(403);
    expect((await raw(srv.url, { headers: { ...auth, host: `evil.example:${port}` }, body: rpc('ping') })).status).toBe(403);
    expect((await raw(srv.url, { headers: { ...auth, origin: `http://localhost:${port}` }, body: rpc('ping') })).status).toBe(200);
    expect((await raw(srv.url, { method: 'GET', headers: auth })).status).toBe(405);
    expect((await raw(srv.url.replace('/mcp', '/other'), { headers: auth, body: rpc('ping') })).status).toBe(404);
    expect((await raw(srv.url, { headers: { ...auth, 'content-type': 'text/plain' }, body: rpc('ping') })).status).toBe(415);
    expect((await raw(srv.url, { headers: auth, body: 'x'.repeat(5000) })).status).toBe(413);
    expect((await raw(srv.url, { headers: auth, body: '{nope' })).status).toBe(400);
  });

  it('stays on this machine unless told otherwise, and wants a real token', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    await expect(serveMcpHttp(rt, { host: '0.0.0.0' })).rejects.toThrow(/allowRemote/);
    await expect(serveMcpHttp(rt, { token: 'short' })).rejects.toThrow(/16 characters/);
  });

  it('the backend serves it when configured, writes the token file and tells the shell only the address', async () => {
    const tokenFile = join(dir, 'secret', 'mcp-http.token');
    process.env.SPICA_TEST_MCP_TOKEN = 'a-fixed-token-for-this-test-123';
    const b = await startBackend({
      dbPath: join(dir, 'db', 'spica.db'),
      providers: [{ id: 'gw', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1` }],
      defaults: { providerId: 'gw', model: 'm', maxTokens: 64 },
      cwd: dir,
      mcpHttp: { tokenEnv: 'SPICA_TEST_MCP_TOKEN', tokenFile },
    });
    const ch = new MessageChannel();
    b.server.attach(nodePort(ch.port1));
    const client = connectBackend(nodePort(ch.port2));
    try {
      expect(b.mcpHttp?.token).toBe('a-fixed-token-for-this-test-123');
      expect(await readFile(tokenFile, 'utf8')).toBe('a-fixed-token-for-this-test-123');
      const info = await client.call<{ url: string }>('mcpHttp');
      expect(info.url).toBe(b.mcpHttp!.url);
      expect(JSON.stringify(info)).not.toContain('a-fixed-token');
      const r = await raw(b.mcpHttp!.url, { headers: { 'content-type': 'application/json', authorization: 'Bearer a-fixed-token-for-this-test-123' }, body: rpc('ping') });
      expect(r.status).toBe(200);
    } finally {
      delete process.env.SPICA_TEST_MCP_TOKEN;
      ch.port1.close();
      ch.port2.close();
      await b.close();
    }
  });
});
