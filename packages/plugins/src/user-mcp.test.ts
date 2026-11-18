// The services the person adds: a real core runtime, a small MCP server program written here (nothing real in it).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runtimeHost } from './host.ts';
import { callTool, hookCtx, makeRuntime, toolNames, until } from './testing/helpers.ts';
import { UserMcpServers, type UserMcpConfig, type UserMcpEvent } from './user-mcp.ts';

vi.setConfig({ testTimeout: 30_000 });

// Tools: hello (says the args it was started with and NOTES_TOKEN), crash (writes a line to stderr and quits).
const SERVER = `import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'notes' } } });
  if (msg.method === 'tools/list') return send({ id: msg.id, result: { tools: [{ name: 'hello', inputSchema: { type: 'object' } }, { name: 'crash', inputSchema: { type: 'object' } }] } });
  if (msg.method === 'tools/call' && msg.params.name === 'hello') return send({ id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ args: process.argv.slice(2), token: process.env.NOTES_TOKEN ?? null, cwd: process.cwd() }) }] } });
  if (msg.method === 'tools/call' && msg.params.name === 'crash') { process.stderr.write('FileNotFoundError: D:\\\\Notes\\\\notes.db\\n'); process.exit(1); }
  send({ id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
});
`;

let dir: string;
let script: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spica-user-mcp-'));
  script = join(dir, 'server.mjs');
  await writeFile(script, SERVER);
  // a .cmd launcher, as npx and uvx are on Windows
  await writeFile(join(dir, 'notes-server.cmd'), `@"${process.execPath}" "%~dp0server.mjs" %*\r\n`);
  return async () => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

let services: UserMcpServers | undefined;
afterEach(async () => {
  await services?.close();
  services = undefined;
});

function setup(restart?: { maxRestarts: number; windowMs: number }) {
  const rt = makeRuntime();
  const events: UserMcpEvent[] = [];
  services = new UserMcpServers({ host: runtimeHost(rt), endTree: false, onEvent: (e) => events.push(e), ...(restart ? { restart } : {}) });
  return { rt, events, s: services };
}

const notes = (patch: Partial<UserMcpConfig> = {}): UserMcpConfig => ({ name: 'notes', command: process.execPath, args: [script, 'D:\\Shared Files'], env: { NOTES_TOKEN: 'nt-secret-1' }, enabled: true, approval: 'ask', ...patch });

const decide = (rt: ReturnType<typeof makeRuntime>, name: string) => rt.hooks.beforeTool({ callId: 'c1', name, input: {}, irreversible: false }, hookCtx);

describe('services the person adds', () => {
  it('switched on: running, its tools in, started with its arguments and variables', async () => {
    const { rt, s, events } = setup();
    await s.set([notes()]);
    expect(s.states()).toEqual([{ name: 'notes', status: 'running', tools: ['notes__hello', 'notes__crash'], logTail: [], protocolVersion: '2025-06-18' }]);
    expect(toolNames(rt)).toEqual(expect.arrayContaining(['notes__hello']));
    const r = JSON.parse((await callTool(rt, 'notes__hello', {})).content);
    expect(r).toMatchObject({ args: ['D:\\Shared Files'], token: 'nt-secret-1' });
    expect(events.map((e) => e.type === 'user-mcp.status' && e.status)).toEqual(['starting', 'running']);
  });

  it('每次询问: each tool asks first; 直接执行: it does not, and the service is not restarted for it', async () => {
    const { rt, s, events } = setup();
    await s.set([notes()]);
    expect((await decide(rt, 'notes__hello')).decision).toEqual({ action: 'confirm', reason: '「notes」：hello' });
    events.length = 0;
    await s.set([notes({ approval: 'auto' })]);
    expect((await decide(rt, 'notes__hello')).decision).toEqual({ action: 'allow' });
    expect(events).toEqual([]);
    // another service's tools are not its business
    await s.set([notes({ approval: 'ask' })]);
    expect((await decide(rt, 'other__hello')).decision).toEqual({ action: 'allow' });
  });

  it('switched off or removed: its tools go and it is off; a change of command restarts it', async () => {
    const { rt, s } = setup();
    await s.set([notes()]);
    await s.set([notes({ enabled: false })]);
    expect(s.states()).toEqual([{ name: 'notes', status: 'off', tools: [], logTail: [] }]);
    expect(toolNames(rt)).not.toContain('notes__hello');
    await s.set([notes({ args: [script, 'D:\\Other'] })]);
    expect(JSON.parse((await callTool(rt, 'notes__hello', {})).content).args).toEqual(['D:\\Other']);
    await s.set([]);
    expect(s.states()).toEqual([]);
    expect(toolNames(rt)).not.toContain('notes__hello');
  });

  it('crashes: started again, then given up with why and the last lines it wrote', async () => {
    const { rt, s, events } = setup({ maxRestarts: 1, windowMs: 60_000 });
    await s.set([notes()]);
    await callTool(rt, 'notes__crash', {});
    await until(() => s.states()[0]!.status === 'running' && toolNames(rt).includes('notes__crash'));
    await callTool(rt, 'notes__crash', {});
    await until(() => s.states()[0]!.status === 'failed');
    const st = s.states()[0]!;
    expect(st.lastError).toBe('60 秒内崩溃 2 次，已停止重启。');
    expect(st.logTail).toEqual(expect.arrayContaining(['FileNotFoundError: D:\\Notes\\notes.db']));
    expect(events.some((e) => e.type === 'user-mcp.error' && e.message.includes('「notes」'))).toBe(true);
  });

  it('a command that cannot start: failed with the reason, the others still start', async () => {
    const { s } = setup();
    await s.set([notes({ name: 'broken', command: 'spica-no-such-program-xyz' }), notes()]);
    const [broken, ok] = s.states();
    expect(broken).toMatchObject({ name: 'broken', status: 'failed' });
    expect(broken!.lastError).toBeTruthy();
    expect(ok).toMatchObject({ name: 'notes', status: 'running' });
  });

  it.runIf(process.platform === 'win32')('a .cmd on PATH (as npx) starts by its bare name, arguments with spaces intact', async () => {
    const { rt, s } = setup();
    await s.set([notes({ command: 'notes-server', args: ['D:\\Team Share\\Docs (2026)', 'a&b'], env: { PATH: `${dir};${process.env.PATH ?? ''}` } })]);
    expect(s.states()[0]!.status).toBe('running');
    expect(JSON.parse((await callTool(rt, 'notes__hello', {})).content).args).toEqual(['D:\\Team Share\\Docs (2026)', 'a&b']);
  });
});
