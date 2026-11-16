// A plugin's user_config at run time: every declared key reaches its servers as
// SPICA_USER_CONFIG; with a required one not filled in it waits (nothing of it
// runs) and starts once it is; a change restarts only its servers; its passwords
// never reach its log; a package from another source does not get them.
import { readFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callTool, manifest, rig, writePlugin, type Rig } from './testing/helpers.ts';

vi.setConfig({ testTimeout: 30_000 });

let r: Rig | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await r?.cleanup();
  r = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A server whose one tool answers with its SPICA_USER_CONFIG (and pid); it also writes the password to stderr. */
const SERVER = `import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const cfg = process.env.SPICA_USER_CONFIG ?? null;
process.stderr.write('started with ' + (cfg ? JSON.parse(cfg).password : 'nothing') + '\\n');
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'a' } } });
  if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'cfg', inputSchema: { type: 'object' } }] } });
  if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ cfg: cfg && JSON.parse(cfg), pid: process.pid }) }] } });
});`;

const USER_CONFIG = {
  server_url: { type: 'url', title: '服务器地址', required: true },
  password: { type: 'password', title: '密码', required: true },
  page_size: { type: 'number', title: '每页条数', default: 20 },
  note: { type: 'text', title: '备注' },
};

async function ticketPlugin() {
  const dir = await writePlugin({
    'manifest.json': manifest('tix', { user_config: USER_CONFIG }),
    'mcp/tix.json': { runtime: 'node', entry: 'server.js' },
    'server.js': SERVER,
    'skills/find/SKILL.md': '---\nname: find\ndescription: Find a ticket\n---\nUse tix__cfg.',
    'commands/today.md': '---\ndescription: today\n---\nToday',
  });
  dirs.push(dir);
  return dir;
}

const cfg = async () => JSON.parse((await callTool(r!.rt, 'tix__cfg', {})).content) as { cfg: Record<string, unknown> | null; pid: number };
const SECRET = 'correct-horse-battery';

describe('user_config at run time', () => {
  it('a required field not filled in: on, but waiting (no servers, skills or commands); filled in, it starts with every key', async () => {
    r = await rig();
    await r.pm.install(await ticketPlugin());
    const d = await r.pm.enable('tix');
    expect(d).toMatchObject({ enabled: true, waiting: true, tools: [] });
    expect(d.config?.missing).toEqual(['server_url', 'password']);
    expect(r.rt.tools.get('tix__cfg')).toBeUndefined();
    expect(r.rt.tools.get('tix__skill')).toBeUndefined();
    expect(r.pm.commands()).toEqual([]);

    const after = await r.pm.setUserConfig('tix', { values: { server_url: 'https://tickets.example.com', password: SECRET } });
    expect(after.waiting).toBeUndefined();
    expect(after.config?.fields.find((f) => f.key === 'password')).toMatchObject({ set: true });
    expect(after.config?.fields.find((f) => f.key === 'password')).not.toHaveProperty('value');
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect((await cfg()).cfg).toEqual({ server_url: 'https://tickets.example.com', password: SECRET, page_size: 20, note: null });
    expect(r.pm.commands().map((c) => c.name)).toEqual(['tix:today']);
  });

  it('a change restarts its servers with the new values; a required one cleared stops it and it waits again', async () => {
    r = await rig(undefined, { userConfig: { tix: { values: { server_url: 'https://a.example.com', password: SECRET } } } });
    await r.pm.install(await ticketPlugin());
    await r.pm.enable('tix');
    const first = await cfg();
    await r.pm.setUserConfig('tix', { values: { server_url: 'https://b.example.com', password: SECRET, note: 'x' } });
    const second = await cfg();
    expect(second.pid).not.toBe(first.pid);
    expect(second.cfg).toMatchObject({ server_url: 'https://b.example.com', note: 'x' });
    const d = await r.pm.setUserConfig('tix', { values: { server_url: 'https://b.example.com' } });
    expect(d).toMatchObject({ enabled: true, waiting: true, tools: [] });
    expect(r.rt.tools.get('tix__cfg')).toBeUndefined();
  });

  it('its passwords never reach its log (the server printed it on stderr)', async () => {
    const lines: string[] = [];
    r = await rig(undefined, { onLog: (_p, l) => lines.push(l), userConfig: { tix: { values: { server_url: 'https://a.example.com', password: SECRET } } } });
    await r.pm.install(await ticketPlugin());
    await r.pm.enable('tix');
    await cfg();
    const log = await readFile(r.pm.logFile('tix'), 'utf8');
    expect(log).toContain('started with [redacted]');
    expect(log).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it('a package of the same name from another source does not get the passwords; plain values stay', async () => {
    r = await rig(undefined, { userConfig: { tix: { values: { server_url: 'https://a.example.com', password: SECRET }, source: 'folder:C:/elsewhere' } } });
    await r.pm.install(await ticketPlugin(), { kind: 'folder', location: 'C:/here' });
    const d = await r.pm.enable('tix');
    expect(d.waiting).toBe(true);
    expect(d.config?.missing).toEqual(['password']);
    expect(d.config?.fields.find((f) => f.key === 'server_url')).toMatchObject({ set: true, value: 'https://a.example.com' });
  });

  it('values from the packaging: marked, locked ones locked; a password from it is never used', async () => {
    r = await rig(undefined, { userConfig: { tix: { values: { server_url: 'https://gw.example.com', password: 'from-a-plain-file', note: 'n' }, deploy: ['server_url', 'password'], locked: ['server_url'] } } });
    await r.pm.install(await ticketPlugin());
    const d = r.pm.describe('tix');
    expect(d.config?.fields.find((f) => f.key === 'server_url')).toMatchObject({ value: 'https://gw.example.com', from: 'deploy', locked: true });
    expect(d.config?.fields.find((f) => f.key === 'note')).toMatchObject({ from: 'user' });
    expect(d.config?.missing).toEqual(['password']);
  });

  it('a plugin without user_config is as before: no form, nothing in its environment', async () => {
    r = await rig();
    const dir = await writePlugin({ 'manifest.json': manifest('plain'), 'mcp/plain.json': { runtime: 'node', entry: 'server.js' }, 'server.js': SERVER });
    dirs.push(dir);
    await r.pm.install(dir);
    const d = await r.pm.enable('plain');
    expect(d).not.toHaveProperty('config');
    expect(d).not.toHaveProperty('waiting');
    expect(JSON.parse((await callTool(r.rt, 'plain__cfg', {})).content).cfg).toBeNull();
  });
});
