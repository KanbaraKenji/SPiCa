// MCP stdio client against a tiny fake MCP server process.
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { makeRuntime, startGateway } from '../testing/helpers.ts';
import { McpStdioClient, mcpToolName } from './client.ts';

const script = fileURLToPath(new URL('../testing/fake-mcp-server.mjs', import.meta.url));
const config = { name: 'fake', command: process.execPath, args: [script] };

let gw: FakeGateway;
beforeEach(async () => {
  gw = await startGateway();
});
afterEach(async () => {
  await gw.stop();
});

describe('MCP stdio client', () => {
  it('lists and calls tools; ignores non-JSON log lines', async () => {
    const c = new McpStdioClient(config);
    await c.connect();
    expect(c.serverInfo).toMatchObject({ name: 'fake' });
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'add', 'fail', 'slow', 'wipe']);
    expect(await c.callTool('add', { a: 2, b: 3 })).toEqual({ content: '5', isError: false });
    expect(await c.callTool('fail', {})).toEqual({ content: 'something broke', isError: true });
    await expect(c.callTool('nope', {})).rejects.toThrow(/unknown tool nope/);
    c.close();
    await expect(c.callTool('echo', { text: 'x' })).rejects.toThrow(/not running|disconnected/);
  });

  it('a call is cancelled when the user interrupts', async () => {
    const c = new McpStdioClient(config);
    await c.connect();
    const ac = new AbortController();
    const t0 = Date.now();
    const p = c.callTool('slow', {}, ac.signal);
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toThrow(/aborted/);
    expect(Date.now() - t0).toBeLessThan(3000);
    c.close();
  });

  it('a server that cannot start gives a clear error', async () => {
    const c = new McpStdioClient({ name: 'missing', command: 'spica-no-such-binary-xyz' });
    await expect(c.connect()).rejects.toThrow(/missing/);
  });
});

describe('MCP tools in the runtime', () => {
  it('adds the server tools, runs them from the agent loop, traces them, and removes them on disconnect', async () => {
    gw.enqueue({ toolCalls: [{ id: 'm1', name: 'fake__echo', args: { text: 'hello mcp' } }] }, { text: 'done' });
    const rt = makeRuntime(gw);
    const { tools, disconnect } = await rt.connectMcp(config);
    expect(tools).toEqual(['fake__echo', 'fake__add', 'fake__fail', 'fake__slow', 'fake__wipe']);
    const s = rt.createSession();
    await s.send('use the echo tool').done;
    expect(JSON.stringify(s.messages()[2]!.content)).toContain('echo: hello mcp');
    expect(JSON.stringify(gw.requests[0]!.body.tools)).toContain('[MCP fake] Echo text back');
    expect(rt.store.listTraces().find((t) => t.kind === 'mcp')).toMatchObject({ initiator: 'tool:fake__echo', target: 'fake', status: 'ok' });

    disconnect();
    expect(rt.tools.get('fake__echo')).toBeUndefined();
    gw.enqueue({ text: 'no tools' });
    await s.send('again').done;
    expect(JSON.stringify(gw.requests.at(-1)!.body.tools ?? [])).not.toContain('fake__');
    await rt.close();
  });

  it('tools the server marks destructive need confirmation', async () => {
    gw.enqueue({ toolCalls: [{ id: 'w1', name: 'fake__wipe', args: {} }] });
    const rt = makeRuntime(gw);
    await rt.connectMcp(config);
    const r = await rt.createSession().send('wipe it').done;
    expect(r.reason).toBe('awaiting_confirm');
    await rt.close();
  });

  it('runtime.close stops the MCP server process', async () => {
    const rt = makeRuntime(gw);
    await rt.connectMcp(config);
    await rt.close();
    expect(rt.tools.get('fake__echo')).toBeUndefined();
  });

  it('a plugin source owns its MCP tools: unregisterSource removes them and stops the server', async () => {
    const exits: { expected: boolean }[] = [];
    const logs: string[] = [];
    const rt = makeRuntime(gw);
    const h = await rt.connectMcp({ ...config, onExit: (i) => exits.push(i), stderrLog: (c) => logs.push(c) }, { source: 'plugin:demo' });
    expect(h.source).toBe('plugin:demo');
    expect(rt.tools.get('fake__echo')).toBeDefined();
    const res = rt.unregisterSource('plugin:demo');
    expect(res).toMatchObject({ tools: 0, mcpServers: 1 }); // tools already gone with the server
    expect(rt.tools.get('fake__echo')).toBeUndefined();
    await res.stopped; // the process has exited when this resolves
    expect(exits).toEqual([expect.objectContaining({ expected: true })]);
    expect(logs.join('')).toContain('fake mcp server starting');
    await rt.close();
  });

  it('reports an unexpected exit', async () => {
    const exits: { code: number | null; expected: boolean; stderrTail: string }[] = [];
    const rt = makeRuntime(gw);
    await rt.connectMcp({ name: 'crashy', command: process.execPath, args: ['-e', "process.stderr.write('dying'); process.exit(7)"], onExit: (i) => exits.push(i) }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(exits[0]).toMatchObject({ code: 7, expected: false, stderrTail: 'dying' });
    await rt.close();
  });

  it('tool names are restricted to safe characters', () => {
    expect(mcpToolName('my server', 'do.thing/now')).toBe('my_server__do_thing_now');
  });
});
