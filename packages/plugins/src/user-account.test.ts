// The user's account, the same for every plugin: SPICA_USER_ACCOUNT in each
// server process (mcp/ and services/) and ctx.user.account in hooks. The host
// passes it in; a change reaches hooks at their next call and restarts servers.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXAMPLE_PLUGIN, callTool, hookCtx, manifest, rig, until, writePlugin, type Rig } from './testing/helpers.ts';

vi.setConfig({ testTimeout: 30_000 });

let r: Rig | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await r?.cleanup();
  r = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A server whose one tool answers with its SPICA_USER_ACCOUNT (and its pid, to see a restart). */
const SERVER = (tool: string) => `import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'a' } } });
  if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: '${tool}', inputSchema: { type: 'object' } }] } });
  if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ account: process.env.SPICA_USER_ACCOUNT ?? null, pid: process.pid }) }] } });
});`;

async function accountPlugin() {
  const dir = await writePlugin({
    'manifest.json': manifest('acct', { permissions: { hooks: ['inject'] } }),
    // (A manifest's env cannot set SPICA_ names at all: the check refuses the plugin.)
    'mcp/tools.json': { runtime: 'node', entry: 'tools.js' },
    'services/svc.json': { runtime: 'node', entry: 'svc.js' },
    'tools.js': SERVER('who'),
    'svc.js': SERVER('svc_who'),
    // A factory: ctx is taken once at enable, the account is read at each call.
    'hooks/who.js': `export default (ctx) => ({ inject() { return [{ position: 'input:before', text: 'account=' + ctx.user.account }]; } });`,
  });
  dirs.push(dir);
  return dir;
}

const who = async (tool: string) => JSON.parse((await callTool(r!.rt, tool, {})).content) as { account: string | null; pid: number };
const hookSays = async () => (await r!.rt.hooks.injections(hookCtx)).map((i) => i.text).find((t) => t.startsWith('account='));

describe('the user account plugins get', () => {
  it('servers of both kinds read SPICA_USER_ACCOUNT, hooks ctx.user.account: the same value', async () => {
    const before = process.env.SPICA_USER_ACCOUNT;
    // The user's own environment, and the host's baseEnv, do not win either.
    process.env.SPICA_USER_ACCOUNT = 'FROM.HOST.ENV';
    try {
      r = await rig(undefined, { userAccount: 'ALEX.CHEN', baseEnv: { SPICA_USER_ACCOUNT: 'FROM.BASE.ENV' } });
      await r.pm.install(await accountPlugin());
      await r.pm.enable('acct');
      expect((await who('acct__who')).account).toBe('ALEX.CHEN');
      expect((await who('acct-svc__svc_who')).account).toBe('ALEX.CHEN');
      expect(await hookSays()).toBe('account=ALEX.CHEN');
      expect(r.pm.userAccount).toBe('ALEX.CHEN');
    } finally {
      if (before === undefined) delete process.env.SPICA_USER_ACCOUNT;
      else process.env.SPICA_USER_ACCOUNT = before;
    }
  });

  it('a change reaches hooks at their next call and restarts the servers with it; the same value again restarts nothing', async () => {
    r = await rig(undefined, { userAccount: 'ALEX.CHEN' });
    await r.pm.install(await accountPlugin());
    await r.pm.enable('acct');
    const first = await who('acct__who');
    await r.pm.setUserAccount('CHEN.ALEX');
    expect(await hookSays()).toBe('account=CHEN.ALEX');
    await until(() => r!.pm.describe('acct').servers.every((s) => s.status === 'running'));
    const after = await who('acct__who');
    expect(after.account).toBe('CHEN.ALEX');
    expect(after.pid).not.toBe(first.pid);
    expect((await who('acct-svc__svc_who')).account).toBe('CHEN.ALEX');

    await r.pm.setUserAccount('CHEN.ALEX');
    expect((await who('acct__who')).pid).toBe(after.pid);
  });

  it('without an account from the host, plugins get an empty one (never a name the manager looked up)', async () => {
    r = await rig();
    await r.pm.install(await accountPlugin());
    await r.pm.enable('acct');
    expect((await who('acct__who')).account).toBe('');
    expect(await hookSays()).toBe('account=');
  });

  it('the example plugin signs a note with it and its hook says so', async () => {
    r = await rig(undefined, { userAccount: 'ALEX.CHEN' });
    await r.pm.install(EXAMPLE_PLUGIN);
    await r.pm.enable('notes');
    await callTool(r.rt, 'notes__write_note', { title: 'plans', text: 'ship it' });
    expect(await readFile(join(r.pm.dataDir('notes'), 'notes', 'plans.md'), 'utf8')).toBe('ship it\n\n— ALEX.CHEN\n');
    expect((await r.rt.hooks.injections(hookCtx)).map((i) => i.text).join('\n')).toContain('Notes are signed ALEX.CHEN.');
  });
});
