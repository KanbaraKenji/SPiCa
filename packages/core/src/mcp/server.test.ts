// Spica's own MCP service over stdio, driven by Spica's MCP client.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { startGateway, tempDir } from '../testing/helpers.ts';
import { McpStdioClient } from './client.ts';

const entry = fileURLToPath(new URL('../host/mcp-main.ts', import.meta.url));
let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;
let cfgPath: string;
beforeEach(async () => {
  gw = await startGateway({ apiKey: 'test-key-123456' });
  ({ dir, cleanup } = await tempDir());
  cfgPath = join(dir, 'backend.json');
  await writeFile(
    cfgPath,
    JSON.stringify({
      dbPath: join(dir, 'spica.db'),
      providers: [{ id: 'gw', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1`, apiKeyEnv: 'SPICA_TEST_GW_KEY' }],
      defaults: { providerId: 'gw', model: 'm', maxTokens: 64 },
      cwd: dir,
      projectsRoot: dir,
    }),
  );
});
afterEach(async () => {
  await gw.stop();
  await cleanup();
});

const start = async () => {
  const c = new McpStdioClient({ name: 'spica', command: process.execPath, args: [entry, '--config', cfgPath], env: { SPICA_TEST_GW_KEY: 'test-key-123456' }, timeoutMs: 30_000 });
  await c.connect();
  return c;
};
const call = async (c: McpStdioClient, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool(name, args);
  if (r.isError) throw new Error(r.content);
  return JSON.parse(r.content) as Record<string, unknown> & unknown[];
};

describe('Spica MCP service (stdio)', () => {
  it('lists the API tools and runs a conversation with spica_run', async () => {
    gw.onRequest(() => ({ text: 'hello from the model' }));
    const c = await start();
    try {
      const names = (await c.listTools()).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['spica_run', 'spica_send', 'spica_answer', 'spica_confirm', 'spica_create_project', 'spica_events', 'spica_get_messages']));
      const r = await call(c, 'spica_run', { text: 'hi' });
      expect(r).toMatchObject({ status: 'idle', answer: 'hello from the model', pending: [], timedOut: false });
      const msgs = await call(c, 'spica_get_messages', { session_id: r.sessionId });
      expect((msgs as unknown as { kind: string }[]).map((m) => m.kind)).toEqual(['user', 'assistant']);
      const events = await call(c, 'spica_events', { since: 0 });
      expect((events as unknown as { type: string }[]).some((e) => e.type === 'run.end')).toBe(true);
      // the key came from the environment variable named in the config
      expect(gw.requests[0]!.headers.authorization).toBe('Bearer test-key-123456');
    } finally {
      await c.close();
    }
  }, 60_000);

  it('state survives a restart of the MCP server, and a second server on the same database is refused', async () => {
    gw.onRequest(() => ({ text: 'ok' }));
    const c1 = await start();
    const r = await call(c1, 'spica_run', { text: 'remember me' });
    const second = new McpStdioClient({ name: 'spica2', command: process.execPath, args: [entry, '--config', cfgPath], env: { SPICA_TEST_GW_KEY: 'x' }, timeoutMs: 15_000 });
    await expect(second.connect()).rejects.toThrow(/in use by process|exited/);
    await c1.close();
    const c2 = await start();
    try {
      const sessions = (await call(c2, 'spica_list_sessions')) as unknown as { id: string }[];
      expect(sessions.map((s) => s.id)).toContain(r.sessionId);
    } finally {
      await c2.close();
    }
  }, 60_000);
});

describe('extensions', () => {
  it('an extension module adds MCP tools and agent tools, and is closed on shutdown', async () => {
    const { readFile } = await import('node:fs/promises');
    const marker = join(dir, 'ext-closed.txt');
    const ext = pathToFileURL(fileURLToPath(new URL('../testing/fake-extension.mjs', import.meta.url))).href;
    const base = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
    await writeFile(cfgPath, JSON.stringify({ ...base, extensions: [{ module: ext, options: { word: 'hi', marker } }, { module: 'spica-no-such-extension' }] }));
    const c = await start();
    try {
      expect(await call(c, 'spica_ext_ping')).toEqual({ pong: 'hi' });
      const tools = (await call(c, 'spica_list_tools')) as unknown as { name: string; source: string }[];
      expect(tools.find((t) => t.name === 'ext_tool')).toMatchObject({ source: 'ext:test' });
      expect(tools.find((t) => t.name === 'read_file')).toMatchObject({ source: 'core' });
    } finally {
      await c.close();
    }
    expect(await readFile(marker, 'utf8')).toBe('closed');
  }, 60_000);
});
