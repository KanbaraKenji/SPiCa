// Model settings through Spica's MCP service: an agent lists, tests and saves
// model connections; the window keeps them; secrets go in and never come out;
// each change waits for the user in the window.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startBackend, type Backend, type ProviderConfig } from './host/backend.ts';
import { connectBackend, type BackendClient } from './host/client.ts';
import { nodePort } from './host/wire.ts';
import { listenFetchable } from './net.ts';
import { mcpDispatcher } from './mcp/server.ts';
import type { HostConnection, HostConnectionDraft, HostModelList, HostModelPointer } from './settings-tools.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { startGateway, tempDir, until } from './testing/helpers.ts';
import type { CoreEvent } from './types.ts';

const API_KEY = 'sk-test-0123456789abcdef';
const CONSUMER_SECRET = 'cs-test-fedcba9876543210';
const CONSUMER_KEY = 'ck-test-key-77aa1234';

let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;
const closers: (() => Promise<void> | void)[] = [];
beforeEach(async () => {
  gw = await startGateway();
  gw.onRequest(() => ({ text: 'pong' }));
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  await gw.stop();
  await cleanup();
});

/**
 * The window's side: an in-memory settings store that sends the providers to the
 * core like the desktop shell does. A pointer to a model that went away moves to
 * the first model left in its connection, else the first one anywhere, else none.
 */
function fakeWindow(client: () => BackendClient) {
  const conns: Omit<HostConnection, 'hasSecret'>[] = [];
  const secrets = new Map<string, string>();
  let def: HostModelPointer | null = null;
  let strong: HostModelPointer | null = null;
  let n = 1;
  const core = (c: Omit<HostConnection, 'hasSecret'>): ProviderConfig => ({
    id: c.id,
    kind: c.kind,
    ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
    ...(c.kind === 'wso2'
      ? { oauth: { tokenUrl: c.tokenUrl, clientId: c.clientId, clientSecret: secrets.get(c.id)!, ...(c.scope ? { scope: c.scope } : {}) } }
      : { apiKey: secrets.get(c.id)! }),
    ...(c.catalogId ? { catalogId: c.catalogId } : {}),
    contextWindows: Object.fromEntries(c.models.map((m) => [m.id, m.contextWindow])),
  });
  const fix = (p: HostModelPointer | null): HostModelPointer | null => {
    if (!p) return null;
    const c = conns.find((x) => x.id === p.connectionId);
    if (c?.models.some((m) => m.id === p.model)) return p;
    if (c?.models[0]) return { connectionId: c.id, model: c.models[0].id };
    const any = conns.find((x) => x.models.length > 0);
    return any ? { connectionId: any.id, model: any.models[0]!.id } : null;
  };
  const push = async () => {
    await client().call('configure', {
      providers: conns.map(core),
      ...(def ? { defaults: { providerId: def.connectionId, model: def.model, ...(strong ? { strongModel: strong.model, strongProviderId: strong.connectionId } : {}) } } : {}),
    });
  };
  const list = (): HostModelList => ({ connections: conns.map((c) => ({ ...c, hasSecret: secrets.has(c.id) })), default: def, strong });
  return {
    list,
    methods: {
      'models.list': () => list(),
      'models.save': async (draft: HostConnectionDraft) => {
        const { secret, ...fields } = draft;
        const id = draft.id ?? `p-${n++}`;
        if (secret) secrets.set(id, secret);
        const saved = { ...fields, id };
        const i = conns.findIndex((c) => c.id === id);
        if (i >= 0) conns[i] = saved;
        else conns.push(saved);
        def = fix(def) ?? (saved.models[0] ? { connectionId: id, model: saved.models[0].id } : null);
        strong = fix(strong);
        await push();
        return list().connections.find((c) => c.id === id)!;
      },
      'models.setDefault': async (p: HostModelPointer) => {
        def = p;
        await push();
      },
      'models.setStrong': async (p: HostModelPointer | null) => {
        strong = p;
        await push();
      },
    },
  };
}

async function setup(opts: { confirm?: boolean; window?: boolean; openConversation?: () => string | null } = {}) {
  const b: Backend = await startBackend({
    dbPath: join(dir, 'db', 'spica.db'),
    providers: [],
    defaults: { providerId: '', model: '', maxTokens: 64 },
    cwd: dir,
    mail: { enabled: false },
    ...(opts.confirm !== undefined ? { agentSettings: { confirmChanges: opts.confirm } } : {}),
  });
  const ch = new MessageChannel();
  let client!: BackendClient;
  const win = fakeWindow(() => client);
  if (opts.window !== false) {
    b.server.attach(nodePort(ch.port1));
    const methods = { ...win.methods, ...(opts.openConversation ? { 'ui.activeSession': opts.openConversation } : {}) };
    client = connectBackend(nodePort(ch.port2), { hostMethods: methods as never });
  }
  const events: CoreEvent[] = [];
  b.runtime.events.on((e) => events.push(e));
  const mcp = mcpDispatcher(b.runtime);
  let id = 1;
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ error?: string; value?: unknown } & Record<string, unknown>> => {
    const r = (await mcp.handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } })) as {
      result: { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
    };
    seen.push(JSON.stringify(r));
    return r.result.isError ? { error: r.result.content[0]!.text } : r.result.structuredContent!;
  };
  const seen: string[] = [];
  const close = async () => {
    mcp.close();
    ch.port1.close();
    ch.port2.close();
    await b.close();
  };
  closers.push(close);
  return { b, client: () => client, win, events, call, seen, close };
}

/** A gateway with a token endpoint and a chat endpoint (all made up). */
async function wso2Gateway(): Promise<string> {
  const server: Server = createServer((req, res) => {
    req.resume();
    if (req.url?.includes('token')) return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"access_token":"t-1","expires_in":3600}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"id":"c","model":"m-gw","choices":[{"index":0,"delta":{"content":"pong"}}]}\n\n' +
        'data: {"id":"c","model":"m-gw","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
    );
  });
  await listenFetchable(server);
  closers.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A local address nothing listens on (refused at once). */
async function closedUrl(): Promise<string> {
  const s = createServer();
  const port = await listenFetchable(s);
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

const asks = (events: CoreEvent[]) => events.filter((e): e is Extract<CoreEvent, { type: 'confirm.request' }> => e.type === 'confirm.request');

describe('model settings over Spica MCP', () => {
  it('set up to ask first: saves after a passing test and the user confirming in the window; the key never comes back out', async () => {
    const { b, client, events, call, seen } = await setup({ confirm: true });
    const pending = call('spica_save_model', { kind: 'openai-compatible', name: 'Gateway A', baseUrl: `${gw.baseUrl}/v1`, model: 'm1', apiKey: API_KEY, contextWindow: 64_000, makeDefault: 'm1' });
    await until(() => asks(events).length === 1);
    const ask = asks(events)[0]!;
    expect(ask).toMatchObject({ sessionId: '', cause: 'settings_change', name: 'spica_save_model' });
    expect(ask.input).toMatchObject({
      action: 'add_connection',
      name: 'Gateway A',
      models: [{ id: 'm1', contextWindow: 64_000, contextFrom: 'user' }],
      addedModels: ['m1'],
      removedModels: [],
      secret: 'new',
      makeDefault: 'm1',
      test: { ok: true, model: 'm1' },
      changes: ['new'],
    });
    // the script cannot answer its own request
    expect((await call('spica_confirm', { session_id: '', call_id: ask.callId, approved: true })).error).toMatch(/only by the user in the Spica window/);
    await client().api.confirm('', ask.callId, true);
    const saved = (await pending) as { saved: boolean; connection: Record<string, unknown>; test: Record<string, unknown> };
    expect(saved).toMatchObject({
      saved: true,
      connection: { name: 'Gateway A', hasSecret: true, models: [{ id: 'm1', contextWindow: 64_000, isDefault: true }] },
      test: { ok: true, steps: { token: 'n/a', model: 'ok' } },
    });
    const id = String(saved.connection.id);
    expect(saved).toMatchObject({ default: { connectionId: id, model: 'm1' } });
    expect(b.runtime.providerIds).toEqual([id]); // the window sent it to the core
    expect(b.runtime.defaults).toMatchObject({ providerId: id, model: 'm1' });

    // listed and tested by id, without the key
    expect(await call('spica_list_models')).toEqual({
      connections: [expect.objectContaining({ id, kind: 'openai-compatible', hasSecret: true, models: [{ id: 'm1', contextWindow: 64_000, contextFrom: 'user', isDefault: true }] })],
      default: { connectionId: id, model: 'm1' },
      strong: null,
    });
    expect(await call('spica_test_model', { id })).toMatchObject({ ok: true, steps: { model: 'ok' } });

    // a change: only what is given changes; the user can say no
    const change = call('spica_save_model', { id, model: 'm1', contextWindow: 32_000 });
    await until(() => asks(events).length === 2);
    expect(asks(events)[1]!.input).toMatchObject({ action: 'change_connection', id, changes: ['models'], addedModels: [], removedModels: [], secret: 'unchanged' });
    await client().api.confirm('', asks(events)[1]!.callId, false);
    expect(await change).toMatchObject({ saved: false, declined: true });

    // a record per change, field names only
    const traces = b.runtime.exportTraces().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).filter((t) => t.kind === 'settings');
    expect(traces).toEqual([
      expect.objectContaining({ initiator: 'mcp', providerId: id, changes: ['new', 'default'], status: 'ok', confirmedBy: 'user' }),
      expect.objectContaining({ providerId: id, changes: ['models'], status: 'aborted' }),
    ]);
    // the key is nowhere: results, events, records, usage log
    for (const where of [seen.join('\n'), JSON.stringify(events), b.runtime.exportTraces(), b.runtime.exportUsageLog()]) expect(where).not.toContain(API_KEY);
  });

  it('a failing test saves nothing and asks nothing; missing fields and an unknown context window are said plainly', async () => {
    const { events, call, win } = await setup();
    const nowhere = await closedUrl();
    const r = await call('spica_save_model', { kind: 'openai-compatible', name: 'Nowhere', baseUrl: `${nowhere}/v1`, model: 'm1', apiKey: API_KEY, contextWindow: 8000 });
    expect(r).toMatchObject({ saved: false, test: { ok: false, steps: { model: 'failed' }, code: 'net.refused' } });
    expect((r.test as { hint: string }).hint).toMatch(/^模型调用失败：/);
    expect(asks(events)).toEqual([]);
    expect(win.list().connections).toEqual([]);

    expect((await call('spica_save_model', { kind: 'openai-compatible', name: 'X', baseUrl: `${gw.baseUrl}/v1`, model: 'm1' })).error).toMatch(/^\[invalid\] required \(field apiKey\)/);
    expect((await call('spica_save_model', { kind: 'openai-compatible', name: 'X', baseUrl: `${gw.baseUrl}/v1`, model: 'unknown-model', apiKey: API_KEY })).error).toMatch(
      /^\[context_window_required\]/,
    );
    expect((await call('spica_save_model', { kind: 'nope', name: 'X', model: 'm' })).error).toMatch(/^\[invalid\] kind must be one of/);
    expect((await call('spica_save_model', { id: 'p-missing', model: 'm' })).error).toMatch(/^\[not_found\]/);
    // a model Spica knows gets its window filled in (the test then fails here: nothing saved, but no error about the window)
    expect(await call('spica_save_model', { kind: 'anthropic', name: 'C', baseUrl: `${nowhere}/v1`, model: 'claude-haiku-5-5', apiKey: API_KEY })).toMatchObject({ saved: false });
   }, 30_000); // a refused connection is retried a few times

  it('WSO2: two test steps, the Consumer Key shows only its end, the secret never', async () => {
    const base = await wso2Gateway();
    const { b, call, seen, events } = await setup();
    const r = await call('spica_save_model', {
      kind: 'wso2',
      name: 'Company gateway',
      baseUrl: `${base}/v1`,
      tokenUrl: `${base}/token`,
      consumerKey: CONSUMER_KEY,
      consumerSecret: CONSUMER_SECRET,
      scope: 'chat',
      model: 'm-gw',
      contextWindow: 128_000,
    });
    expect(r).toMatchObject({ saved: true, connection: { kind: 'wso2', consumerKey: '…1234', scope: 'chat', hasSecret: true }, test: { ok: true, steps: { token: 'ok', model: 'ok' }, serverModel: 'm-gw' } });
    expect(asks(events)).toEqual([]); // not set up to ask
    const id = String((r.connection as { id: string }).id);
    expect(await call('spica_test_model', { id })).toMatchObject({ ok: true, steps: { token: 'ok', model: 'ok' } });
    // a wrong token address: the token step fails, the model step is skipped
    expect(await call('spica_test_model', { id, tokenUrl: `${await closedUrl()}/token` })).toMatchObject({ ok: false, steps: { token: 'failed', model: 'skipped' }, code: 'wso2.token_unreachable' });
    for (const where of [seen.join('\n'), JSON.stringify(events), b.runtime.exportTraces(), b.runtime.exportUsageLog()]) {
      expect(where).not.toContain(CONSUMER_SECRET);
      expect(where).not.toContain(CONSUMER_KEY);
    }
  });

  it('by default a change applies at once and is shown in the conversation open in the window (else the one used last), also after a restart', async () => {
    const first = await setup({ openConversation: () => open });
    let open: string | null = null;
    // the first model: nothing to show it in yet but the main conversation, created now that a model exists
    const r = await first.call('spica_save_model', { kind: 'openai-compatible', name: 'Gateway A', baseUrl: `${gw.baseUrl}/v1`, model: 'm1', apiKey: API_KEY, contextWindow: 64_000 });
    expect(r).toMatchObject({ saved: true });
    expect(asks(first.events)).toEqual([]);
    const id = String((r.connection as { id: string }).id);
    const changed = first.events.filter((e) => e.type === 'settings.changed');
    expect(changed).toHaveLength(1);
    const change = changed[0]!.type === 'settings.changed' ? changed[0]!.change : undefined;
    expect(change).toMatchObject({ action: 'add_connection', id, name: 'Gateway A', addedModels: ['m1'], changes: ['new'], secret: 'new', by: 'mcp', confirmed: false, test: { ok: true } });
    expect(change).toMatchObject({ defaultMoved: { from: null, to: { connectionId: id, model: 'm1' } } }); // the first model became the default
    const top = first.b.runtime.top();
    const note = (s: { messages(): { meta?: Record<string, unknown> }[] }) => s.messages().filter((m) => m.meta?.settingsChange);
    expect(note(top).map((m) => m.meta!.settingsChange)).toEqual([change]);

    // another conversation is open in the window: the next change shows there too
    const other = first.b.runtime.createSession();
    open = other.id;
    expect(await first.call('spica_set_default_model', { id })).toEqual({ default: { connectionId: id, model: 'm1' } }); // already the default
    // a second model under the same key, made the default
    expect(await first.call('spica_save_model', { id, addModels: [{ id: 'm2', contextWindow: 32_000 }], makeDefault: 'm2' })).toMatchObject({ saved: true, default: { connectionId: id, model: 'm2' } });
    expect(note(top)).toHaveLength(1); // only where the user is looking
    expect(note(other).map((m) => m.meta!.settingsChange)).toEqual([
      expect.objectContaining({
        action: 'change_connection',
        addedModels: ['m2'],
        changes: ['models', 'default'],
        secret: 'unchanged',
        defaultMoved: { from: { connectionId: id, model: 'm1' }, to: { connectionId: id, model: 'm2' } },
      }),
    ]);
    // unticking the default model: the window moves the default, and the card says where
    expect(await first.call('spica_save_model', { id, removeModels: ['m2'] })).toMatchObject({ saved: true, default: { connectionId: id, model: 'm1' } });
    expect(note(other).at(-1)!.meta!.settingsChange).toMatchObject({ removedModels: ['m2'], defaultMoved: { from: { connectionId: id, model: 'm2' }, to: { connectionId: id, model: 'm1' } } });
    expect(first.b.runtime.defaults).toMatchObject({ providerId: id, model: 'm1' });
    // the model in that conversation reads it as data
    const noteText = other.messages().find((m) => m.meta?.settingsChange)!.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(noteText).toContain('<untrusted_data kind="mcp" source="settings">');
    const traces = first.b.runtime.exportTraces().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).filter((t) => t.kind === 'settings');
    expect(traces.map((t) => t.confirmedBy)).toEqual(['none', 'none', 'none']);
    for (const where of [JSON.stringify(first.events), JSON.stringify(top.messages()), JSON.stringify(other.messages())]) expect(where).not.toContain(API_KEY);
    const topId = top.id;
    const otherId = other.id;
    closers.splice(closers.indexOf(first.close), 1);
    await first.close();

    // after a restart the cards are still in the history
    const again = await setup();
    expect(note(again.b.runtime.session(topId)!)).toHaveLength(1);
    expect(note(again.b.runtime.session(otherId)!)).toHaveLength(2);
  });

  it('a preset fills in the address and its recommended models under one key; relay names are matched and marked; listing models works with a preset', async () => {
    const { call, win, seen } = await setup();
    const presets = (await call('spica_list_presets')).value as { id: string; needsKey: boolean; models: { id: string; price?: unknown }[] }[];
    expect(presets.map((p) => p.id)).toEqual(expect.arrayContaining(['deepseek', 'anthropic', 'ollama']));
    expect(presets.find((p) => p.id === 'moonshot')!.models[0]).not.toHaveProperty('price'); // no official price: none shown
    expect(presets.find((p) => p.id === 'ollama')!.needsKey).toBe(false);

    const r = await call('spica_save_model', { preset: 'deepseek', baseUrl: `${gw.baseUrl}/v1`, apiKey: API_KEY, makeStrong: 'deepseek-v4-pro' });
    expect(r).toMatchObject({
      saved: true,
      connection: {
        name: 'DeepSeek',
        preset: 'deepseek',
        models: [
          { id: 'deepseek-flash', contextWindow: 1_048_576, contextFrom: 'catalog', isDefault: true },
          { id: 'deepseek-v4-pro', contextWindow: 1_048_576, contextFrom: 'catalog', isStrong: true },
        ],
      },
    });
    expect(win.list().connections).toHaveLength(1); // two models, one key
    expect(win.list().connections[0]).toMatchObject({ catalogId: 'deepseek', kind: 'openai-compatible' });
    // a relay spelling a known model its own way: matched by name and marked; an unknown name is not saved quietly
    const relay = await call('spica_save_model', { kind: 'openai-compatible', name: 'Relay', baseUrl: `${gw.baseUrl}/v1`, apiKey: API_KEY, models: ['deepseek/DeepSeek-V4-Pro'] });
    expect(relay).toMatchObject({ saved: true, connection: { models: [{ id: 'deepseek/DeepSeek-V4-Pro', contextWindow: 1_048_576, contextFrom: 'name-match' }] } });
    expect((await call('spica_save_model', { kind: 'openai-compatible', name: 'Relay 2', baseUrl: `${gw.baseUrl}/v1`, apiKey: API_KEY, models: ['relay/secret-sauce-9'] })).error).toMatch(
      /^\[context_window_required\] .*relay\/secret-sauce-9/,
    );
    expect((await call('spica_save_model', { preset: 'nope', apiKey: API_KEY })).error).toMatch(/^\[not_found\] no preset nope/);
    // a local preset needs no key
    expect(await call('spica_test_model', { preset: 'ollama', baseUrl: `${gw.baseUrl}/v1`, model: 'm1' })).toMatchObject({ ok: true });

    // what the provider has now (here a made-up one), with the preset's short list merged in
    const list = createServer((req, res) => {
      res.writeHead(req.headers.authorization === `Bearer ${API_KEY}` ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-x-new' }] }));
    });
    const port = await listenFetchable(list);
    closers.push(() => new Promise<void>((r) => (list.closeAllConnections(), list.close(() => r()))));
    const listed = await call('spica_list_provider_models', { preset: 'deepseek', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: API_KEY });
    expect(listed).toEqual({ ok: true, models: [expect.objectContaining({ id: 'deepseek-flash', inCatalog: true, contextWindow: 1_048_576 }), expect.objectContaining({ id: 'deepseek-x-new', inCatalog: false })] });
    expect(seen.join('\n')).not.toContain(API_KEY);
  });

  it('a model without a context window yet (moved over from older settings) is listed as missing one, and a save asks for it', async () => {
    const { call, win } = await setup();
    const saved = await win.methods['models.save']({
      kind: 'openai-compatible',
      name: 'Old',
      baseUrl: `${gw.baseUrl}/v1`,
      tokenUrl: '',
      clientId: '',
      scope: '',
      maxConcurrent: null,
      requestsPerMinute: null,
      secret: API_KEY,
      models: [
        { id: 'm1', contextWindow: 64_000, contextFrom: 'user' },
        { id: 'm-old-strong', contextWindow: 0, contextFrom: 'user' },
      ],
    });
    const listed = (await call('spica_list_models')) as { connections: { models: Record<string, unknown>[] }[] };
    expect(listed.connections[0]!.models[1]).toMatchObject({ id: 'm-old-strong', contextWindow: null, needsContextWindow: true });
    expect((await call('spica_save_model', { id: saved.id, name: 'Old one' })).error).toMatch(/^\[context_window_required\] .*m-old-strong/);
    expect(await call('spica_save_model', { id: saved.id, models: [{ id: 'm1' }, { id: 'm-old-strong', contextWindow: 200_000 }] })).toMatchObject({
      saved: true,
      connection: { models: [{ id: 'm1', contextWindow: 64_000 }, { id: 'm-old-strong', contextWindow: 200_000, contextFrom: 'user' }] },
    });
  });

  it('an address that only works with /v1 added: the agent\'s save uses the same test, saves that address and says so', async () => {
    const s = createServer((req, res) => {
      req.resume();
      if (req.url === '/api/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return void res.end('data: {"id":"c","model":"m1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
      }
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    });
    const base = `http://127.0.0.1:${await listenFetchable(s)}`;
    closers.push(() => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r()))));
    const { call, win, events } = await setup();
    expect(await call('spica_test_model', { kind: 'openai-compatible', baseUrl: `${base}/api`, model: 'm1', apiKey: API_KEY })).toMatchObject({ ok: true, suggestedBaseUrl: `${base}/api/v1` });
    const r = await call('spica_save_model', { kind: 'openai-compatible', name: 'Gateway', baseUrl: `${base}/api`, apiKey: API_KEY, model: 'm1', contextWindow: 8000 });
    expect(r).toMatchObject({ saved: true, baseUrlAdjusted: { from: `${base}/api`, to: `${base}/api/v1` }, connection: { baseUrl: `${base}/api/v1` } });
    expect(win.list().connections[0]!.baseUrl).toBe(`${base}/api/v1`);
    const change = events.find((e) => e.type === 'settings.changed');
    expect(change?.type === 'settings.changed' ? change.change.baseUrl : null).toBe(`${base}/api/v1`); // the card shows the address that is saved
  });

  it('a user who has not answered yet: the agent hears it is waiting and asks again', async () => {
    const { b, client, events, call } = await setup({ confirm: true });
    b.runtime.settingsBridge!.waitMs = 30;
    const first = await call('spica_save_model', { kind: 'openai-compatible', name: 'A', baseUrl: `${gw.baseUrl}/v1`, model: 'm1', apiKey: API_KEY, contextWindow: 8000 });
    expect(first).toMatchObject({ status: 'waiting_for_user', requestId: asks(events)[0]!.callId });
    expect(await call('spica_settings_result', { requestId: String(first.requestId) })).toMatchObject({ status: 'waiting_for_user' });
    const again = call('spica_settings_result', { requestId: String(first.requestId) });
    await client().api.confirm('', String(first.requestId), true);
    // the answer may land after this wait ran out: then the next call has it
    let r = await again;
    if (r.status === 'waiting_for_user') r = await call('spica_settings_result', { requestId: String(first.requestId) });
    expect(r).toMatchObject({ saved: true });
    expect((await call('spica_settings_result', { requestId: 'nope' })).error).toMatch(/^\[not_found\]/);
  });

  it('without a window: listing and saving say so, testing a connection and the network status still work', async () => {
    const { call } = await setup({ window: false });
    expect((await call('spica_list_models')).error).toMatch(/^\[host_unavailable\]/);
    expect(await call('spica_test_model', { kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1`, model: 'm1', apiKey: API_KEY })).toMatchObject({ ok: true });
    expect(await call('spica_network_status')).toEqual({ proxy: null, noProxy: expect.any(Array), caFile: null, useSystemCa: expect.any(Boolean) });
  });
});
