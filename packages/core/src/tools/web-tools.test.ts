import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listenFetchable } from '../net.ts';
import { MemoryStore } from '../store/memory.ts';
import { anthropicProvider, makeRuntime, openaiProvider, startGateway } from '../testing/helpers.ts';
import { Tracer } from '../trace.ts';
import type { CoreEventBody } from '../types.ts';
import type { ToolContext } from './types.ts';
import { createWebFetchTool, createWebSearchTool, htmlToText, jsonSearchBackend, pageTitle } from './web-tools.ts';

// gateways, child processes and local servers start slowly when several full runs share the machine
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(
        '<!doctype html><html><head><title>Offer page</title><style>.x{}</style><script>alert(1)</script></head>' +
          '<body><h1>Supplier &amp; Co</h1><p>Price: 12&nbsp;EUR &#8364; &#x4e2d;</p><ul><li>Fast</li><li>Cheap</li></ul>' +
          '<a href="https://example.com/terms">Terms</a></body></html>',
      );
    }
    if (u.pathname === '/redirect') {
      res.writeHead(302, { location: '/page' });
      return res.end();
    }
    if (u.pathname === '/loop') {
      res.writeHead(302, { location: '/loop' });
      return res.end();
    }
    if (u.pathname === '/missing') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not here');
    }
    if (u.pathname === '/bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(Buffer.from([0, 1, 2, 3, 0]));
    }
    if (u.pathname === '/long') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('x'.repeat(5000));
    }
    if (u.pathname === '/search') {
      res.writeHead(200, { 'content-type': 'application/json' });
      const q = u.searchParams.get('q');
      const n = Number(u.searchParams.get('n'));
      return res.end(JSON.stringify({ data: { items: Array.from({ length: n }, (_, i) => ({ name: `${q} result ${i + 1}`, link: `https://r.example/${i + 1}`, desc: 'snippet', date: '2026-11-01' })) } }));
    }
    res.writeHead(500);
    res.end();
  });
  await listenFetchable(server);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
});

const store = new MemoryStore();
const ctx = (): ToolContext => ({
  sessionId: 's1',
  parentChain: ['p1'],
  cwd: '.',
  signal: new AbortController().signal,
  tracer: new Tracer(store),
  extractors: [],
  services: {},
  callId: 'c1',
  emit: () => {},
});

describe('web_fetch', () => {
  const tool = createWebFetchTool();

  it('turns HTML into readable text and leaves a fetch trace', async () => {
    const r = await tool.execute({ url: `${base}/page` }, ctx());
    expect(r.isError).toBe(false);
    expect(r.content).toContain('Status: 200');
    expect(r.content).toContain('Offer page');
    expect(r.content).toContain('# Supplier & Co');
    expect(r.content).toContain('Price: 12 EUR € 中');
    expect(r.content).toContain('- Fast');
    expect(r.content).toContain('Terms (https://example.com/terms)');
    expect(r.content).not.toContain('alert');
    const t = store.listTraces().at(-1)!;
    expect(t).toMatchObject({ kind: 'fetch', initiator: 'tool:web_fetch', sessionId: 's1', parentChain: ['p1'], status: 'ok', httpStatus: 200 });
    expect(t.target).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(t.bytes).toBeGreaterThan(100);
  });

  it('follows redirects and reports the final URL; stops redirect loops', async () => {
    const r = await tool.execute({ url: `${base}/redirect` }, ctx());
    expect(r.content).toContain(`URL: ${base}/page`);
    const loop = await tool.execute({ url: `${base}/loop` }, ctx());
    expect(loop.isError).toBe(true);
    expect(loop.content).toMatch(/too many redirects/);
  });

  it('marks HTTP errors, hides binary bodies, truncates long text, rejects other schemes', async () => {
    const missing = await tool.execute({ url: `${base}/missing` }, ctx());
    expect(missing).toMatchObject({ isError: true });
    expect(missing.content).toContain('Status: 404');
    expect((await tool.execute({ url: `${base}/bin` }, ctx())).content).toMatch(/binary content, 5 bytes/);
    const long = await tool.execute({ url: `${base}/long`, max_chars: 1000 }, ctx());
    expect(long.content).toMatch(/showing first 1000 of 5000 characters/);
    expect((await tool.execute({ url: 'file:///etc/passwd' }, ctx())).isError).toBe(true);
    expect((await tool.execute({ url: 'not a url' }, ctx())).isError).toBe(true);
  });
});

describe('htmlToText', () => {
  it('decodes entities and keeps structure', () => {
    expect(htmlToText('<p>a&lt;b &amp; c</p><p>next</p>')).toBe('a<b & c\n\nnext');
  });
});

describe('web_search', () => {
  const backend = () =>
    jsonSearchBackend({
      id: 'test-search',
      url: `${base}/search?q={query}&n={count}`,
      resultsPath: 'data.items',
      fields: { title: 'name', url: 'link', snippet: 'desc', published: 'date' },
    });

  it('formats results from a generic JSON backend and leaves a search trace', async () => {
    const tool = createWebSearchTool(backend());
    const r = await tool.execute({ query: 'iso 9001', count: 2 }, ctx());
    expect(r.content).toContain('1. iso 9001 result 1\n   https://r.example/1\n   published: 2026-11-01\n   snippet');
    expect(r.content).toContain('2. iso 9001 result 2');
    expect(r.content).not.toContain('result 3');
    expect(store.listTraces().at(-1)).toMatchObject({ kind: 'search', target: 'test-search', status: 'ok' });
  });

  it('is offered only when a backend is configured and the model has no hosted search on', async () => {
    const gw = await startGateway();
    try {
      const names = (rt: ReturnType<typeof makeRuntime>) => {
        const s = rt.createSession();
        return rt.tools.list({ providerId: s.config.providerId, serverWebSearch: !!s.config.serverWebSearch }, s.config.tools).map((t) => t.spec.name);
      };
      expect(names(makeRuntime(gw))).not.toContain('web_search');
      expect(names(makeRuntime(gw, { search: backend() }))).toContain('web_search');
      const hosted = makeRuntime(gw, {
        search: backend(),
        providers: [anthropicProvider(gw)],
        defaults: { providerId: 'fake-anthropic', model: 'claude-haiku-5-5', maxTokens: 64 },
      });
      expect(names(hosted)).not.toContain('web_search'); // hosted search is used instead
      expect(hosted.createSession().config.serverWebSearch).toBe(true);
      const noHosted = makeRuntime(gw, {
        search: backend(),
        hostedWebSearch: false,
        providers: [anthropicProvider(gw), openaiProvider(gw)],
        defaults: { providerId: 'fake-anthropic', model: 'claude-haiku-5-5', maxTokens: 64 },
      });
      expect(names(noHosted)).toContain('web_search');
      expect(names(makeRuntime(gw))).toContain('web_fetch');
    } finally {
      await gw.stop();
    }
  });
});

describe('source cards', () => {
  const capture = () => {
    const seen: CoreEventBody[] = [];
    return { seen, c: { ...ctx(), emit: (b: CoreEventBody) => void seen.push(b) } };
  };

  it('web_fetch: the page it ended up on, with its title; none for errors', async () => {
    const tool = createWebFetchTool();
    const { seen, c } = capture();
    await tool.execute({ url: `${base}/redirect` }, c);
    expect(seen).toEqual([
      { type: 'source.card', callId: 'c1', card: { tool: 'web_fetch', sources: [{ url: `${base}/page`, title: 'Offer page', fetchedAt: expect.any(String) }] } },
    ]);
    const plain = capture();
    await tool.execute({ url: `${base}/long` }, plain.c);
    expect(plain.seen[0]).toMatchObject({ card: { sources: [{ url: `${base}/long`, title: null }] } });
    const missing = capture();
    await tool.execute({ url: `${base}/missing` }, missing.c);
    expect(missing.seen).toEqual([]);
  });

  it('web_search: every result, with the query', async () => {
    const tool = createWebSearchTool(
      jsonSearchBackend({ id: 'test-search', url: `${base}/search?q={query}&n={count}`, resultsPath: 'data.items', fields: { title: 'name', url: 'link', snippet: 'desc', published: 'date' } }),
    );
    const { seen, c } = capture();
    await tool.execute({ query: 'iso', count: 2 }, c);
    expect(seen[0]).toMatchObject({
      type: 'source.card',
      card: {
        tool: 'web_search',
        query: 'iso',
        sources: [
          { url: 'https://r.example/1', title: 'iso result 1', snippet: 'snippet', published: '2026-11-01' },
          { url: 'https://r.example/2', title: 'iso result 2' },
        ],
      },
    });
  });

  it('page titles: entities decoded, spaces collapsed, none when missing', () => {
    expect(pageTitle('<title>\n  A &amp; B &#8364;  </title>')).toBe('A & B €');
    expect(pageTitle('<p>no title</p>')).toBeNull();
  });
});
