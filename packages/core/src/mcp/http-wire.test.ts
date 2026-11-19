// MCP servers at a web address: the 2026-07-28 way, the older Streamable HTTP with sessions, the deprecated
// HTTP+SSE, a key in a header, and what goes wrong (no key, a wrong one, an untrusted certificate, nobody there).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpStdioClient, MODERN_PROTOCOL } from './client.ts';
import { headerValue, readEvents } from './http-wire.ts';
// @ts-expect-error a plain .mjs test server
import { startFakeMcpHttp } from '../testing/fake-mcp-http.mjs';

vi.setConfig({ testTimeout: 30_000 });

type Fake = { url: string; seen: { method: string; path: string; headers: Record<string, string>; body: string }[]; forgetSessions(): void; close(): Promise<void> };

const open: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of open.splice(0).reverse()) await c();
});

async function fake(o: { era: 'modern' | 'legacy' | 'sse'; key?: string; tls?: { cert: Buffer; key: Buffer } }): Promise<Fake> {
  const f = (await startFakeMcpHttp(o)) as Fake;
  open.push(() => f.close());
  return f;
}

function client(url: string, extra: { headers?: Record<string, string>; onExit?: () => void } = {}) {
  const log: string[] = [];
  const c = new McpStdioClient({ name: 'lab', command: '', url, protocol: 'auto', stderrLog: (l) => log.push(l), ...extra });
  open.push(() => c.close());
  return { c, log };
}

const KEY = 'lab-key-0000-1111-2222';

describe('MCP at a web address', () => {
  it('2026-07-28: no handshake; each POST says its version, method and tool name (and the argument a tool marks); an event-stream answer with progress', async () => {
    const f = await fake({ era: 'modern' });
    const { c } = client(f.url);
    await c.connect();
    expect(c.protocolVersion).toBe(MODERN_PROTOCOL);
    expect(c.serverInfo.name).toBe('fake-http');
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['room_temperature']);
    const progress: number[] = [];
    const r = await c.callTool('room_temperature', { room: 'lab' }, undefined, (p) => progress.push(p.progress));
    expect(r).toEqual({ content: 'lab: 23.5 °C', isError: false });
    expect(progress).toEqual([1]);
    const call = f.seen.find((s) => s.body.includes('tools/call'))!;
    expect(call.headers).toMatchObject({ 'mcp-protocol-version': MODERN_PROTOCOL, 'mcp-method': 'tools/call', 'mcp-name': 'room_temperature', 'mcp-param-room': 'lab', accept: 'application/json, text/event-stream' });
    expect(f.seen.some((s) => s.body.includes('"initialize"'))).toBe(false);
  });

  it('an older server (2025-06-18): back to initialize; its session goes with every request and is ended on close', async () => {
    const f = await fake({ era: 'legacy' });
    const { c } = client(f.url);
    await c.connect();
    expect(c.protocolVersion).toBe('2025-06-18');
    const r = await c.callTool('room_temperature', { room: 'lab' });
    expect(r.content).toBe('lab: 23.5 °C');
    const call = f.seen.find((s) => s.body.includes('tools/call'))!;
    expect(call.headers['mcp-session-id']).toMatch(/^s-/);
    expect(call.headers['mcp-protocol-version']).toBe('2025-06-18');
    await c.close();
    expect(f.seen.at(-1)).toMatchObject({ method: 'DELETE' });
  });

  it('an older server that forgot the session: the connection is lost (its owner starts it again)', async () => {
    const f = await fake({ era: 'legacy' });
    const onExit = vi.fn();
    const { c } = client(f.url, { onExit });
    await c.connect();
    f.forgetSessions();
    await expect(c.listTools()).rejects.toThrow(/ended its session/);
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ code: null, expected: false }));
    expect(c.running).toBe(false);
  });

  it('the deprecated HTTP+SSE (2024-11-05): the POST is refused, a GET finds where to send, answers come on the stream', async () => {
    const f = await fake({ era: 'sse' });
    const { c, log } = client(f.url);
    await c.connect();
    expect(c.protocolVersion).toBe('2024-11-05');
    expect((await c.callTool('room_temperature', { room: 'lab' })).content).toBe('lab: 23.5 °C');
    expect(log.join('')).toMatch(/HTTP\+SSE/);
  });

  it('a key: sent as given; never in the log. No key or a wrong one: HTTP 401', async () => {
    const f = await fake({ era: 'modern', key: KEY });
    const ok = client(f.url, { headers: { authorization: `Bearer ${KEY}` } });
    await ok.c.connect();
    expect(f.seen.every((s) => s.headers.authorization === `Bearer ${KEY}`)).toBe(true);

    const none = client(f.url);
    await expect(none.c.connect()).rejects.toThrow(/answered HTTP 401/);
    const wrong = client(f.url, { headers: { authorization: 'Bearer nope-nope-nope' } });
    await expect(wrong.c.connect()).rejects.toThrow(/answered HTTP 401/);
    expect([...ok.log, ...none.log, ...wrong.log].join('')).not.toMatch(/lab-key|nope-nope/);
  });

  it('nobody at the address: could not be reached (net.refused)', async () => {
    const f = await fake({ era: 'modern' });
    const url = f.url;
    await f.close();
    open.pop();
    const { c } = client(url);
    await expect(c.connect()).rejects.toThrow(/could not be reached \(net\.refused\)/);
  });

  it.runIf(hasOpenssl())('a certificate this computer does not trust: could not be reached (tls.untrusted)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-mcp-tls-'));
    open.push(async () => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'o.cnf'), ['[req]', 'distinguished_name=dn', '[dn]', '[ext]', 'subjectAltName=IP:127.0.0.1', ''].join('\n'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '2', '-subj', '/CN=127.0.0.1', '-config', 'o.cnf', '-extensions', 'ext'], {
      cwd: dir,
      stdio: 'pipe',
      env: { ...process.env, OPENSSL_CONF: join(dir, 'o.cnf') },
    });
    const f = await fake({ era: 'modern', tls: { cert: readFileSync(join(dir, 'c.pem')), key: readFileSync(join(dir, 'k.pem')) } });
    const { c } = client(f.url);
    await expect(c.connect()).rejects.toThrow(/could not be reached \(tls\.untrusted\)/);
  });

  it('header values: plain ASCII as is, anything else in base64', () => {
    expect(headerValue('us-west1')).toBe('us-west1');
    expect(headerValue('Hello, 世界')).toBe('=?base64?SGVsbG8sIOS4lueVjA==?=');
    expect(headerValue(' padded ')).toBe('=?base64?IHBhZGRlZCA=?=');
    expect(headerValue('=?base64?x?=')).toBe(`=?base64?${Buffer.from('=?base64?x?=').toString('base64')}?=`);
  });

  it('an event stream: events split on blank lines, comments skipped, CRLF taken', async () => {
    const got: { event: string; data: string }[] = [];
    const body = new Response(': hi\r\n\r\nevent: endpoint\r\ndata: /m?x=1\r\n\r\ndata: a\ndata: b\n\n').body!;
    await readEvents(body, (e) => got.push(e));
    expect(got).toEqual([
      { event: 'endpoint', data: '/m?x=1' },
      { event: 'message', data: 'a\nb' },
    ]);
  });
});

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
