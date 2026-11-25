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
  if (msg.method === 'tools/call' && msg.params.name === 'crash') { process.stderr.write('FileNotFoundError: D:\\\\Notes\\\\notes.db (token ' + process.env.NOTES_TOKEN + ')\\n'); process.exit(1); }
  if (msg.method === 'server/discover' && process.env.QUIT_ON_DISCOVER) process.exit(4);
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
    // the window names its tools as the person wrote the service's name
    expect(rt.tools.get('notes__hello')?.server).toBe('notes');
    const r = JSON.parse((await callTool(rt, 'notes__hello', {})).content);
    expect(r).toMatchObject({ args: ['D:\\Shared Files'], token: 'nt-secret-1' });
    expect(events.map((e) => e.type === 'user-mcp.status' && e.status)).toEqual(['starting', 'running']);
  });

  it('每次询问: each tool asks first; 直接执行: it does not, and the service is not restarted for it', async () => {
    const { rt, s, events } = setup();
    await s.set([notes()]);
    const asked = (await decide(rt, 'notes__hello')).decision;
    expect(asked).toEqual({ action: 'confirm', reason: '「notes」：hello', keep: expect.stringMatching(/^mcp:[0-9a-f]{12}:notes__hello$/) });
    // 始终允许 is kept per tool, and for the service where it runs: another of its tools, or the same name
    // running something else, is another key
    const key = (d: typeof asked) => (d.action === 'confirm' ? d.keep : undefined);
    expect(key((await decide(rt, 'notes__crash')).decision)).not.toBe(key(asked));
    await s.set([notes({ args: [script, 'D:\\Other'] })]);
    expect(key((await decide(rt, 'notes__hello')).decision)).not.toBe(key(asked));
    await s.set([notes({ env: { NOTES_TOKEN: 'nt-secret-2' } })]);
    expect(key((await decide(rt, 'notes__hello')).decision)).toBe(key(asked));
    await s.set([notes()]);
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
    expect(st.problem).toEqual({ kind: 'crash-loop', count: 2, seconds: 60 });
    // what it wrote, its variable's value taken out
    expect(st.logTail).toEqual(expect.arrayContaining(['FileNotFoundError: D:\\Notes\\notes.db (token [redacted])']));
    expect(JSON.stringify([st, events])).not.toContain('nt-secret-1');
    expect(events.some((e) => e.type === 'user-mcp.error' && e.message.includes('「notes」'))).toBe(true);
  });

  it('a command that cannot start: failed with the reason, the others still start', async () => {
    const { s } = setup();
    await s.set([notes({ name: 'broken', command: 'spica-no-such-program-xyz' }), notes()]);
    const [broken, ok] = s.states();
    expect(broken).toMatchObject({ name: 'broken', status: 'failed' });
    expect(broken!.lastError).toBeTruthy();
    expect(broken!.problem).toEqual({ kind: 'not-found', command: 'spica-no-such-program-xyz' });
    // a program that never started did not quit on the version probe: tried once
    expect(broken!.logTail.join(' ')).not.toContain('server/discover');
    expect(ok).toMatchObject({ name: 'notes', status: 'running' });
  });

  it('a server that quits when asked server/discover: started again with the handshake, and added', async () => {
    const { rt, s } = setup();
    await s.set([notes({ env: { NOTES_TOKEN: 'nt-secret-1', QUIT_ON_DISCOVER: '1' } })]);
    expect(s.states()[0]).toMatchObject({ status: 'running', protocolVersion: '2025-06-18' });
    expect(s.states()[0]!.logTail).toEqual(expect.arrayContaining(['[spica] quit when asked server/discover: starting again with initialize']));
    expect(JSON.parse((await callTool(rt, 'notes__hello', {})).content).token).toBe('nt-secret-1');
  });

  it.runIf(process.platform === 'win32')('a .cmd on PATH (as npx) starts by its bare name, arguments with spaces intact', async () => {
    const { rt, s } = setup();
    await s.set([notes({ command: 'notes-server', args: ['D:\\Team Share\\Docs (2026)', 'a&b'], env: { PATH: `${dir};${process.env.PATH ?? ''}` } })]);
    expect(s.states()[0]!.status).toBe('running');
    expect(JSON.parse((await callTool(rt, 'notes__hello', {})).content).args).toEqual(['D:\\Team Share\\Docs (2026)', 'a&b']);
  });
});

// Pretend npx, uvx and the app's uv: each "downloads" by writing a marker (no network), and refuses to when told
// not to, with the words the real ones use. Then they run the test server.
const RUNNER = `import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [kind, marker, server, ...args] = process.argv.slice(2);
const offline = kind === 'npx' ? process.env.npm_config_yes === 'false' : args.includes('--offline');
const here = existsSync(marker);
if (!here && offline) {
  process.stderr.write(kind === 'npx' ? 'npm error npx canceled due to missing packages and no YES option: ["@example/files@1.0.0"]\\n' : "error: Network connectivity is disabled, but the requested data wasn't found in the cache\\n");
  process.exit(1);
}
if (!here) writeFileSync(marker, JSON.stringify({ args, uvPython: process.env.UV_PYTHON_DOWNLOADS ?? null }));
const child = spawn(process.execPath, [server], { stdio: 'inherit' });
child.on('exit', (c) => process.exit(c ?? 0));
`;

describe.runIf(process.platform === 'win32')('npx and uvx: nothing downloaded until allowed', () => {
  async function launcher(name: string): Promise<{ bin: string; marker: string }> {
    const bin = join(dir, `bin-${name}`);
    await mkdtemp(bin).catch(() => undefined);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'runner.mjs'), RUNNER);
    const marker = join(bin, 'downloaded.json');
    const kind = name === 'npx' ? 'npx' : 'uvx';
    await writeFile(join(bin, `${name}.cmd`), `@"${process.execPath}" "%~dp0runner.mjs" ${kind} "${marker}" "${script}" %*\r\n`);
    return { bin, marker };
  }

  it('npx: offline first; 待下载 with what; after the person agrees, 正在下载 then running; the next start needs nothing', async () => {
    const { bin, marker } = await launcher('npx');
    const rt = makeRuntime();
    const events: UserMcpEvent[] = [];
    // the registry, as a stub: how big the package is
    const s = new UserMcpServers({ host: runtimeHost(rt), endTree: false, onEvent: (e) => events.push(e), fetchJson: async () => ({ version: '1.4.0', dist: { unpackedSize: 52_000 } }) });
    services = s;
    const env = { PATH: `${bin};${process.env.PATH ?? ''}` };
    await s.set([notes({ command: 'npx', args: ['-y', '@example/files'], env })]);
    await until(() => s.states()[0]?.download?.bytes !== undefined);
    expect(s.states()[0]).toMatchObject({ status: 'needs-download', download: { runner: 'npx', package: '@example/files', python: false, version: '1.4.0', bytes: 52_000 } });
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(false);
    // waiting is not a crash: never restarted meanwhile
    await new Promise((r) => setTimeout(r, 800));
    expect(events.filter((e) => e.type === 'user-mcp.status').map((e) => (e as { status: string }).status)).not.toContain('restarting');
    events.length = 0;
    await s.download('notes');
    expect(events.map((e) => e.type === 'user-mcp.status' && e.status)).toEqual(['downloading', 'running']);
    expect(s.states()[0]).toMatchObject({ status: 'running' });
    expect(s.states()[0]!.download).toBeUndefined();
    expect(toolNames(rt)).toContain('notes__hello');
    // switched off and on: here already, no question
    await s.set([notes({ command: 'npx', args: ['-y', '@example/files'], env, enabled: false })]);
    await s.set([notes({ command: 'npx', args: ['-y', '@example/files'], env })]);
    expect(s.states()[0]!.status).toBe('running');
  });

  it('uvx missing from the computer: the app\'s uv runs it (tool run), offline first, Python downloads only once allowed', async () => {
    const { bin, marker } = await launcher('uv');
    const rt = makeRuntime();
    services = new UserMcpServers({ host: runtimeHost(rt), endTree: false, uv: { exe: join(bin, 'uv.cmd'), root: join(dir, 'app-python') } });
    // a PATH without any uvx
    await services.set([notes({ command: 'uvx', args: ['example-notes'], env: { PATH: process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '' } })]);
    expect(services.states()[0]).toMatchObject({ status: 'needs-download', download: { runner: 'uvx', package: 'example-notes', python: true } });
    await services.download('notes');
    expect(services.states()[0]!.status).toBe('running');
    const { readFileSync } = await import('node:fs');
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ args: ['tool', 'run', 'example-notes'], uvPython: 'automatic' });
  });
});
