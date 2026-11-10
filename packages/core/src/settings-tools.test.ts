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
import { mcpDispatcher } from './mcp/server.ts';
import type { HostModel, HostModelDraft } from './settings-tools.ts';
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

/** The window's side: an in-memory settings store that sends the providers to the core like the desktop shell does. */
function fakeWindow(client: () => BackendClient) {
  const models: Omit<HostModel, 'isDefault'>[] = [];
  const secrets = new Map<string, string>();
  let defaultId: string | null = null;
  let n = 1;
  const core = (m: Omit<HostModel, 'isDefault'>): ProviderConfig => ({
    id: m.id,
    kind: m.kind,
    ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
    ...(m.kind === 'wso2'
      ? { oauth: { tokenUrl: m.tokenUrl, clientId: m.clientId, clientSecret: secrets.get(m.id)!, ...(m.scope ? { scope: m.scope } : {}) } }
      : { apiKey: secrets.get(m.id)! }),
    ...(m.contextWindow ? { contextWindows: { [m.model]: m.contextWindow } } : {}),
  });
  const push = async () => {
    const d = models.find((m) => m.id === defaultId);
    await client().call('configure', { providers: models.map(core), ...(d ? { defaults: { providerId: d.id, model: d.model } } : {}) });
  };
  const list = (): HostModel[] => models.map((m) => ({ ...m, isDefault: m.id === defaultId }));
  return {
    models: list,
    methods: {
      'models.list': () => list(),
      'models.save': async (draft: HostModelDraft) => {
        const { secret, ...fields } = draft;
        const id = draft.id ?? `p-${n++}`;
        if (secret) secrets.set(id, secret);
        const saved = { ...fields, id, hasSecret: secrets.has(id) };
        const i = models.findIndex((m) => m.id === id);
        if (i >= 0) models[i] = saved;
        else models.push(saved);
        defaultId ??= id;
        await push();
        return list().find((m) => m.id === id)!;
      },
      'models.setDefault': async (id: string) => {
        defaultId = id;
        await push();
      },
    },
  };
}

async function setup(opts: { confirm?: boolean; window?: boolean } = {}) {
  const b: Backend = await startBackend({
    dbPath: join(dir, 'db', 'spica.db'),
    providers: [],
    defaults: { providerId: '', model: '', maxTokens: 64 },
    cwd: dir,
    mail: { enabled: false },
    ...(opts.confirm === false ? { agentSettings: { confirmChanges: false } } : {}),
  });
  const ch = new MessageChannel();
  let client!: BackendClient;
  const win = fakeWindow(() => client);
  if (opts.window !== false) {
    b.server.attach(nodePort(ch.port1));
    client = connectBackend(nodePort(ch.port2), { hostMethods: win.methods as never });
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
  closers.push(async () => {
    mcp.close();
    ch.port1.close();
    ch.port2.close();
    await b.close();
  });
  return { b, client: () => client, win, events, call, seen };
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
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A local address nothing listens on (refused at once). */
async function closedUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

const asks = (events: CoreEvent[]) => events.filter((e): e is Extract<CoreEvent, { type: 'confirm.request' }> => e.type === 'confirm.request');

describe('model settings over Spica MCP', () => {
  it('saves a new connection after a passing test and the user confirming in the window; the key never comes back out', async () => {
    const { b, client, events, call, seen } = await setup();
    const pending = call('spica_save_model', { kind: 'openai-compatible', name: 'Gateway A', baseUrl: `${gw.baseUrl}/v1`, model: 'm1', apiKey: API_KEY, contextWindow: 64_000, makeDefault: true });
    await until(() => asks(events).length === 1);
    const ask = asks(events)[0]!;
    expect(ask).toMatchObject({ sessionId: '', cause: 'settings_change', name: 'spica_save_model' });
    expect(ask.input).toMatchObject({ action: 'add_model', name: 'Gateway A', model: 'm1', secret: 'new', makeDefault: true, test: { ok: true }, changes: ['new'] });
    // the script cannot answer its own request
    expect((await call('spica_confirm', { session_id: '', call_id: ask.callId, approved: true })).error).toMatch(/only by the user in the Spica window/);
    await client().api.confirm('', ask.callId, true);
    const saved = (await pending) as { saved: boolean; model: Record<string, unknown>; test: Record<string, unknown> };
    expect(saved).toMatchObject({ saved: true, model: { name: 'Gateway A', hasSecret: true, isDefault: true, contextWindow: 64_000 }, test: { ok: true, steps: { token: 'n/a', model: 'ok' } } });
    const id = String(saved.model.id);
    expect(b.runtime.providerIds).toEqual([id]); // the window sent it to the core
    expect(b.runtime.defaults).toMatchObject({ providerId: id, model: 'm1' });

    // listed and tested by id, without the key
    expect((await call('spica_list_models')).value).toEqual([expect.objectContaining({ id, kind: 'openai-compatible', hasSecret: true, isDefault: true })]);
    expect(await call('spica_test_model', { id })).toMatchObject({ ok: true, steps: { model: 'ok' } });

    // a change: only what is given changes; the user can say no
    const change = call('spica_save_model', { id, contextWindow: 32_000 });
    await until(() => asks(events).length === 2);
    expect(asks(events)[1]!.input).toMatchObject({ action: 'change_model', id, changes: ['contextWindow'], secret: 'unchanged' });
    await client().api.confirm('', asks(events)[1]!.callId, false);
    expect(await change).toMatchObject({ saved: false, declined: true });

    // a record per change, field names only
    const traces = b.runtime.exportTraces().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).filter((t) => t.kind === 'settings');
    expect(traces).toEqual([
      expect.objectContaining({ initiator: 'mcp', providerId: id, changes: ['new', 'default'], status: 'ok', confirmedBy: 'user' }),
      expect.objectContaining({ providerId: id, changes: ['contextWindow'], status: 'aborted' }),
    ]);
    // the key is nowhere: results, events, records, usage log
    for (const where of [seen.join('\n'), JSON.stringify(events), b.runtime.exportTraces(), b.runtime.exportUsageLog()]) expect(where).not.toContain(API_KEY);
  });

  it('a failing test saves nothing and asks nothing; missing fields and an unknown context window are said plainly', async () => {
    const { events, call, win } = await setup();
    const nowhere = await closedUrl();
    const r = await call('spica_save_model', { kind: 'openai-compatible', name: 'Nowhere', baseUrl: `${nowhere}/v1`, model: 'm1', apiKey: API_KEY, contextWindow: 8000 });
    expect(r).toMatchObject({ saved: false, test: { ok: false, steps: { model: 'failed' }, code: 'net.refused' } });
    expect((r.test as { hint: string }).hint).toMatch(/^调模型失败：/);
    expect(asks(events)).toEqual([]);
    expect(win.models()).toEqual([]);

    expect((await call('spica_save_model', { kind: 'openai-compatible', name: 'X', baseUrl: `${gw.baseUrl}/v1`, model: 'm1' })).error).toMatch(/^\[invalid\] required \(field apiKey\)/);
    expect((await call('spica_save_model', { kind: 'openai-compatible', name: 'X', baseUrl: `${gw.baseUrl}/v1`, model: 'unknown-model', apiKey: API_KEY })).error).toMatch(
      /^\[context_window_required\]/,
    );
    expect((await call('spica_save_model', { kind: 'nope', name: 'X', model: 'm' })).error).toMatch(/^\[invalid\] kind must be one of/);
    expect((await call('spica_save_model', { id: 'p-missing', model: 'm' })).error).toMatch(/^\[not_found\]/);
    // a model Spica knows gets its window filled in (the test then fails here: nothing saved, but no error about the window)
    expect(await call('spica_save_model', { kind: 'anthropic', name: 'C', baseUrl: `${nowhere}/v1`, model: 'claude-haiku-5-5', apiKey: API_KEY })).toMatchObject({ saved: false });
   }, 30_000); // a refused connection is retried a few times

  it('WSO2: two test steps, the Consumer Key shows only its end, the secret never; confirmations can be switched off', async () => {
    const base = await wso2Gateway();
    const { b, call, seen, events } = await setup({ confirm: false });
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
    expect(r).toMatchObject({ saved: true, model: { kind: 'wso2', consumerKey: '…1234', scope: 'chat', hasSecret: true }, test: { ok: true, steps: { token: 'ok', model: 'ok' }, serverModel: 'm-gw' } });
    expect(asks(events)).toEqual([]); // switched off: no card
    const id = String((r.model as { id: string }).id);
    expect(await call('spica_test_model', { id })).toMatchObject({ ok: true, steps: { token: 'ok', model: 'ok' } });
    // a wrong token address: the token step fails, the model step is skipped
    expect(await call('spica_test_model', { id, tokenUrl: `${await closedUrl()}/token` })).toMatchObject({ ok: false, steps: { token: 'failed', model: 'skipped' }, code: 'wso2.token_unreachable' });
    for (const where of [seen.join('\n'), JSON.stringify(events), b.runtime.exportTraces(), b.runtime.exportUsageLog()]) {
      expect(where).not.toContain(CONSUMER_SECRET);
      expect(where).not.toContain(CONSUMER_KEY);
    }
  });

  it('a user who has not answered yet: the agent hears it is waiting and asks again', async () => {
    const { b, client, events, call } = await setup();
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
