// The plugin as Spica sees it: manifest check, install → enable → tools →
// hook keeps attachments in the project folder → disable → tools gone.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider, Runtime } from '@spica/core';
import { PluginManager, hasErrors, runtimeHost } from '@spica/plugins';
import { PLUGIN_DIR } from './mcp-client.mjs';

function makeRuntime() {
  return new Runtime({
    providers: [new OpenAICompatibleProvider({ id: 'fake', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-key-123456' })],
    defaults: { providerId: 'fake', model: 'fake-model', maxTokens: 256 },
    tools: [],
  });
}

const names = (rt) => rt.tools.list({ providerId: 'fake', serverWebSearch: false }).map((t) => t.spec.name).sort();

describe('outlook plugin in Spica', () => {
  let rt;
  let pm;
  let root;
  let project;

  /** Run a tool the way the loop does: hooks first, then the tool. */
  async function use(name, input) {
    const { decision, input: finalInput } = await rt.hooks.beforeTool({ callId: 'c1', name, input, irreversible: !!rt.tools.get(name)?.spec.irreversible }, { session: { cwd: project }, runId: 'r1', turn: 1 });
    if (decision.action === 'deny') return { decision, content: decision.reason, isError: true };
    if (decision.action === 'confirm') return { decision };
    const out = await rt.tools.get(name).execute(finalInput, {
      sessionId: 's1',
      parentChain: [],
      cwd: project,
      signal: new AbortController().signal,
      tracer: rt.tracer,
      extractors: [],
      services: {},
      callId: 'c1',
      emit() {},
    });
    return { decision, ...out };
  }

  beforeAll(async () => {
    rt = makeRuntime();
    root = await mkdtemp(join(tmpdir(), 'spica-outlook-plugin-'));
    project = await mkdtemp(join(tmpdir(), 'spica-outlook-project-'));
    pm = new PluginManager({ host: runtimeHost(rt), root });
  });

  afterAll(async () => {
    await pm?.shutdown();
    await rt?.close();
    await rm(root, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  it('passes the plugin check with no warnings', async () => {
    const f = await pm.check(PLUGIN_DIR);
    expect(f.issues).toEqual([]);
    expect(hasErrors(f.issues)).toBe(false);
    expect(f.manifest.name).toBe('outlook');
    expect(f.skills.map((s) => s.id)).toEqual(['triage']);
    expect(f.commands.map((c) => c.id)).toEqual(['triage']);
  });

  it('installs, enables with mock data, and its tools appear', async () => {
    await pm.install(PLUGIN_DIR, { kind: 'folder', location: PLUGIN_DIR });
    await pm.setMock(true);
    const d = await pm.enable('outlook');
    expect(d.servers[0].status).toBe('running');
    expect(names(rt)).toEqual([
      'outlook__create_draft',
      'outlook__list_folders',
      'outlook__list_messages',
      'outlook__mark_read',
      'outlook__move_messages',
      'outlook__read_message',
      'outlook__save_attachments',
      'outlook__skill',
      'outlook__status',
    ]);
    const list = await use('outlook__list_messages', { limit: 50 });
    expect(list.content).toContain('[sample data — mock mode]');
  }, 30_000);

  it('asks before moving, not before marking or drafting', async () => {
    expect((await use('outlook__move_messages', { ids: ['mock-001'], folder: 'Archive' })).decision.action).toBe('confirm');
    expect((await use('outlook__mark_read', { ids: ['mock-001'] })).decision.action).toBe('allow');
    const draft = await use('outlook__create_draft', { reply_to: 'mock-003', body: '收到，周六可以。' });
    expect(draft.decision.action).toBe('allow');
    expect(draft.content).toContain('"sent": false');
  });

  it('saves attachments into the project folder only', async () => {
    const ok = await use('outlook__save_attachments', { id: 'mock-003' });
    expect(ok.isError).toBe(false);
    expect(await readdir(join(project, 'attachments'))).toEqual(['quote-SM-3306.txt']);
    const sub = await use('outlook__save_attachments', { id: 'mock-003', dest_folder: 'quotes/move' });
    expect(JSON.parse(sub.content.slice(sub.content.indexOf('{'))).saved[0].path).toBe(join(project, 'quotes', 'move', 'quote-SM-3306.txt'));
    const out = await use('outlook__save_attachments', { id: 'mock-003', dest_folder: '../elsewhere' });
    expect(out.decision.action).toBe('deny');
    expect(out.content).toMatch(/^\[PATH_NOT_ALLOWED\]/);
    const abs = await use('outlook__save_attachments', { id: 'mock-003', dest_folder: tmpdir() });
    expect(abs.decision.action).toBe('deny');
    const over = await use('outlook__save_attachments', { id: 'mock-003', overwrite: true });
    expect(over.decision.action).toBe('confirm');
  });

  it('disabling removes every tool and hook', async () => {
    await pm.disable('outlook');
    expect(names(rt)).toEqual([]);
    expect(rt.hooks.sources).toEqual([]);
  });
});

describe('repository rules', () => {
  it('never calls Send in server code', async () => {
    const dir = join(PLUGIN_DIR, 'server');
    for (const f of await readdir(dir)) {
      expect(await readFile(join(dir, f), 'utf8'), f).not.toMatch(/\.Send\s*\(/i);
    }
  });

  it('sample mail is fictional: 30 messages, example domains only', async () => {
    const data = JSON.parse(await readFile(join(PLUGIN_DIR, 'mock', 'mailbox.json'), 'utf8'));
    expect(data.messages).toHaveLength(30);
    const text = JSON.stringify(data);
    const addresses = text.match(/[\w.+-]+@[\w.-]+/g);
    expect(addresses.length).toBeGreaterThan(30);
    for (const a of addresses.map((x) => x.replace(/\.$/, ''))) expect(a, a).toMatch(/\.(example|test)$/);
    expect(new Set(data.messages.map((m) => m.id)).size).toBe(30);
    const zh = data.messages.filter((m) => /[一-鿿]/.test(m.subject)).length;
    expect(zh).toBeGreaterThan(8);
    expect(30 - zh).toBeGreaterThan(8);
  });
});
