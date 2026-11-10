// Settings that change while the backend runs (no restart).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySettings, startBackend } from './host/backend.ts';
import { connectBackend } from './host/client.ts';
import { nodePort } from './host/wire.ts';
import { RateLimiter } from './limiter.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway, tempDir } from './testing/helpers.ts';
import type { CoreEvent } from './types.ts';

let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  gw = await startGateway();
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  vi.useRealTimers();
  await gw.stop();
  await cleanup();
});

describe('mail.configure', () => {
  it('reschedules, stops and starts polling without a restart, and says so', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    let lists = 0;
    const rt = makeRuntime(gw, { cwd: dir, mail: { enabled: true, intervalMinutes: 5 } });
    rt.tools.register({ spec: { name: 'm__list', description: '', inputSchema: { type: 'object' } }, execute: async () => ((lists += 1), { content: '{"messages":[]}' }) }, 'p');
    rt.tools.register({ spec: { name: 'm__read', description: '', inputSchema: { type: 'object' } }, execute: async () => ({ content: '{}' }) }, 'p');
    rt.mail.addSource({ id: 'm', listTool: 'm__list', readTool: 'm__read' });
    const events: CoreEvent[] = [];
    rt.events.on((e) => events.push(e));
    expect(rt.mail.start()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(lists).toBe(1); // first poll right away
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(lists).toBe(2);

    rt.mail.configure({ intervalMinutes: 1 });
    expect(rt.mail.running).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000 + 10);
    expect(lists).toBeGreaterThanOrEqual(4); // immediate poll after the restart + one per minute

    rt.mail.configure({ enabled: false });
    expect(rt.mail.running).toBe(false);
    const before = lists;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(lists).toBe(before);

    rt.mail.configure({ enabled: true, ignore: { from: ['noreply@'] } });
    expect(rt.mail.running).toBe(true);
    expect(rt.mail.settings).toMatchObject({ enabled: true, intervalMinutes: 1, ignore: { from: ['noreply@'] } });
    const configured = events.filter((e) => e.type === 'mail.configured');
    expect(configured.map((e) => (e.type === 'mail.configured' ? e.running : null))).toEqual([true, false, true]);
    rt.mail.stop();
  });
});

describe('runtime settings', () => {
  it('a higher concurrency limit releases waiting calls at once', async () => {
    const lim = new RateLimiter({ maxConcurrent: 1 });
    const a = await lim.acquire();
    let got = false;
    const p = lim.acquire().then((l) => ((got = true), l));
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toBe(false);
    lim.configure({ maxConcurrent: 2 });
    (await p).release();
    expect(got).toBe(true);
    a.release();
  });

  it('spending limits, defaults, providers, workflows, locale and search change for what comes next', async () => {
    gw.onRequest(() => ({ text: 'ok', usage: { input: 10_000, output: 100 } }));
    const rt = makeRuntime(gw, { cwd: dir });
    const events: CoreEvent[] = [];
    rt.events.on((e) => events.push(e));

    // budget: a tiny per-run limit blocks, raising it lets the next run through
    applySettings(rt, { budget: { perRunUsd: 0.000001 } });
    expect((await rt.createSession().send('a').done).reason).toBe('budget');
    applySettings(rt, { budget: { perRunUsd: 5 } });
    expect((await rt.createSession().send('b').done).reason).toBe('completed');

    // providers: add a second one, make it the default; the first one goes away
    const old = rt.createSession();
    applySettings(rt, {
      providers: [{ id: 'second', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1`, limits: { maxConcurrent: 1 } }],
      defaults: { providerId: 'second', model: 'other-model' },
    });
    expect(rt.providerIds).toEqual(['second']);
    const fresh = rt.createSession();
    expect(fresh.config).toMatchObject({ providerId: 'second', model: 'other-model' });
    await fresh.send('c').done;
    expect(gw.requests.at(-1)!.body.model).toBe('other-model');
    const r = await old.send('d').done; // still on the removed provider
    expect(r).toMatchObject({ reason: 'error', detail: 'unknown provider: fake-openai' });
    expect(() => rt.setDefaults({ providerId: 'nope' })).toThrow(/unknown provider/);

    // workflows from another folder
    const wf = join(dir, 'wf');
    await mkdir(wf, { recursive: true });
    await writeFile(join(wf, 'a.json'), JSON.stringify({ id: 'audit', name: 'Audit', stages: [{ id: 'plan' }] }));
    await writeFile(join(wf, 'bad.json'), '{');
    const res = applySettings(rt, { workflowsDir: wf, locale: 'en-US' });
    expect([...rt.workflows.keys()]).toEqual(['audit']);
    expect(res.warnings.join(' ')).toMatch(/bad\.json/);
    expect(rt.createSession().config.locale).toBe('en-US');

    // search appears and disappears
    applySettings(rt, { search: { id: 's', url: 'http://127.0.0.1:9/?q={query}', resultsPath: 'r', fields: { title: 't', url: 'u' } } });
    expect(rt.tools.get('web_search')).toBeDefined();
    applySettings(rt, { search: null });
    expect(rt.tools.get('web_search')).toBeUndefined();

    expect(events.filter((e) => e.type === 'runtime.configured').map((e) => (e.type === 'runtime.configured' ? e.changed : []))).toEqual([
      ['budget'],
      ['budget'],
      ['providers', 'defaults'],
      ['workflows', 'locale'],
      ['search'],
      ['search'],
    ]);
  });

  it('configure works over the backend port', async () => {
    const b = await startBackend({
      dbPath: join(dir, 'db', 'spica.db'),
      providers: [{ id: 'gw', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1` }],
      defaults: { providerId: 'gw', model: 'm', maxTokens: 64 },
      cwd: dir,
      mail: { enabled: false },
    });
    const ch = new MessageChannel();
    b.server.attach(nodePort(ch.port1));
    const client = connectBackend(nodePort(ch.port2));
    try {
      const r = await client.call<{ changed: string[] }>('configure', { mail: { intervalMinutes: 2 }, defaults: { model: 'n' } });
      expect(r.changed).toEqual(['defaults', 'mail']);
      expect(await client.call('mailSettings')).toMatchObject({ enabled: false, intervalMinutes: 2, running: false, sources: [] });
      expect(b.runtime.defaults.model).toBe('n');
    } finally {
      ch.port1.close();
      ch.port2.close();
      await b.close();
    }
  });

  it('extensions hear when the network settings change for child processes, only then', async () => {
    let calls = 0;
    const b = await startBackend(
      {
        dbPath: join(dir, 'db', 'spica.db'),
        providers: [{ id: 'gw', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1` }],
        defaults: { providerId: 'gw', model: 'm', maxTokens: 64 },
        cwd: dir,
        mail: { enabled: false },
        network: { proxy: null, caFile: null, useSystemCa: false },
        extensions: [{ module: 'net-listener' }],
      },
      { modules: { 'net-listener': { attachBackend: () => ({ networkChanged: () => void calls++ }) } } },
    );
    try {
      applySettings(b.runtime, { network: { proxy: { url: 'http://proxy.example:8080' }, caFile: null, useSystemCa: false } });
      expect(calls).toBe(1);
      applySettings(b.runtime, { network: { proxy: { url: 'http://proxy.example:8080' }, caFile: null, useSystemCa: false } }); // the same again
      applySettings(b.runtime, { locale: 'en-US' }); // not the network
      expect(calls).toBe(1);
      applySettings(b.runtime, { network: { proxy: null, caFile: null, useSystemCa: false } });
      expect(calls).toBe(2);
    } finally {
      await b.close();
    }
  });

  it('settings change on a fresh install with no model configured, and create no session', () => {
    const rt = makeRuntime(gw, { cwd: dir, providers: [], defaults: { providerId: 'none', model: 'none', maxTokens: 64 } });
    const events: CoreEvent[] = [];
    rt.events.on((e) => events.push(e));
    expect(applySettings(rt, { providers: [], mail: { intervalMinutes: 3 }, locale: 'en-US' }).changed).toEqual(['providers', 'locale', 'mail']);
    expect(rt.sessions()).toEqual([]);
    expect(events.filter((e) => e.type === 'runtime.configured' || e.type === 'mail.configured').map((e) => e.sessionId)).toEqual(['', '']);
    // the first model arrives: from now on there can be sessions
    applySettings(rt, { providers: [{ id: 'gw', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1` }], defaults: { providerId: 'gw', model: 'm' } });
    expect(rt.createSession().config.providerId).toBe('gw');
  });

  it('context windows come from the model settings first, then the known table; the form can ask what is known', async () => {
    const b = await startBackend({
      dbPath: join(dir, 'db', 'spica.db'),
      providers: [{ id: 'gw', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1`, contextWindows: { m: 128_000, bad: -1 } }],
      defaults: { providerId: 'gw', model: 'm', maxTokens: 64 },
      cwd: dir,
      mail: { enabled: false },
    });
    const ch = new MessageChannel();
    b.server.attach(nodePort(ch.port1));
    const client = connectBackend(nodePort(ch.port2));
    const events: CoreEvent[] = [];
    b.runtime.events.on((e) => events.push(e));
    try {
      expect(b.warnings.join(' ')).toMatch(/gw: context window ignored for bad/);
      const s = b.runtime.createSession();
      expect(s.info().contextWindow).toBe(128_000); // no price needed
      s.setModel('gw', 'claude-haiku-5-5');
      expect(s.info().contextWindow).toBeNull(); // the gateway is not 'anthropic': nothing set, nothing known for this kind
      s.setModel('gw', 'm');

      // changed while running: the open session says so right away
      events.length = 0;
      await client.call('configure', { providers: [{ id: 'gw', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1`, contextWindows: { m: 64_000 } }] });
      expect(s.info().contextWindow).toBe(64_000);
      const updated = events.filter((e) => e.type === 'session.updated' && e.sessionId === s.id);
      expect(updated.map((e) => (e.type === 'session.updated' ? e.info.contextWindow : null))).toEqual([64_000]);
      // left out: back to the known table (here: nothing)
      await client.call('configure', { providers: [{ id: 'gw', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1` }] });
      expect(s.info().contextWindow).toBeNull();

      // what the core knows, to pre-fill the form (also the same model behind another kind of endpoint)
      expect(await client.call('knownContextWindow', 'anthropic', 'claude-haiku-5-5')).toBe(1_000_000);
      expect(await client.call('knownContextWindow', 'wso2', 'claude-sonnet-5-5')).toBe(1_000_000);
      expect((await client.call('knownContextWindow', 'openai-compatible', 'deepseek-flash')) ?? null).toBeNull(); // the port gives null as undefined
      // a configured value is not "known"
      await client.call('configure', { providers: [{ id: 'gw', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1`, contextWindows: { m: 64_000 } }] });
      expect((await client.call('knownContextWindow', 'openai-compatible', 'm')) ?? null).toBeNull();
    } finally {
      ch.port1.close();
      ch.port2.close();
      await b.close();
    }
  });
});
