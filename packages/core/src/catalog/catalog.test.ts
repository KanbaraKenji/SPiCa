// The model catalog: every entry has an official source and a check date; it is
// the one source of the default prices and known context windows; companies add
// presets; "get the models from the provider" never blocks the form.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CostLedger, DEFAULT_PRICES } from '../cost.ts';
import { listenFetchable } from '../net.ts';
import { makeRuntime, startGateway } from '../testing/helpers.ts';
import { BUILTIN_CATALOG } from './builtin.ts';
import { catalogProblems, effectiveCatalog, presetProblems, pricesFromCatalog, staleEntries, type CatalogPreset, type ModelCatalog } from './catalog.ts';
import { listProviderModels } from './list-models.ts';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});
async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<string> {
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => handler(req, res, body));
  });
  servers.push(s);
  return `http://127.0.0.1:${await listenFetchable(s)}`;
}
const json = (res: ServerResponse, status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));

/** Made-up company presets (no real company, addresses under example.internal). */
const PRESETS: CatalogPreset[] = [
  {
    id: 'company-gateway',
    name: '公司网关',
    kind: 'wso2',
    baseUrl: 'https://llm-gw.example.internal/v1',
    tokenUrl: 'https://llm-gw.example.internal/oauth2/token',
    scope: 'default',
    models: [
      { id: 'model-a', contextWindow: 128_000, role: 'default' },
      { id: 'model-b', contextWindow: 200_000, role: 'strong' },
    ],
    default: true,
  },
];

describe('the built-in catalog', () => {
  it('is valid, and every provider and model names its official source and check date', () => {
    expect(catalogProblems(BUILTIN_CATALOG)).toEqual([]);
    for (const p of BUILTIN_CATALOG.providers) {
      expect(p.source, p.id).toMatch(/^https:\/\//);
      for (const m of p.models) {
        expect(m.source, m.id).toMatch(/^https?:\/\//);
        expect(m.checked, m.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    expect(BUILTIN_CATALOG.providers.map((p) => p.id)).toEqual(['deepseek', 'bailian', 'zhipu', 'moonshot', 'ark', 'siliconflow', 'openai', 'anthropic', 'gemini', 'openrouter', 'ollama', 'lmstudio']);
  });

  it('refuses entries without a source or a check date, and says which', () => {
    const broken = structuredClone(BUILTIN_CATALOG) as ModelCatalog;
    delete broken.providers[0]!.models[0]!.source;
    delete broken.providers[1]!.checked;
    broken.providers[2]!.models[0]!.contextWindow = 0;
    expect(catalogProblems(broken)).toEqual([
      'providers[0] (deepseek).models[0] (deepseek-flash): source (an official page) missing',
      'providers[1] (bailian): checked (YYYY-MM-DD) missing',
      'providers[2] (zhipu).models[0] (glm-5.3): contextWindow must be a positive whole number',
    ]);
  });

  it('lists entries checked too long ago (before a release)', () => {
    expect(staleEntries(BUILTIN_CATALOG, 60, new Date('2026-11-20'))).toEqual([]);
    const later = staleEntries(BUILTIN_CATALOG, 60, new Date('2027-03-01'));
    expect(later.length).toBeGreaterThan(30);
    expect(later[0]).toEqual({ provider: 'deepseek', checked: '2026-11-10', source: 'https://api-docs.deepseek.com/' });
  });
});

describe('prices and context windows come from the catalog', () => {
  it('official prices in USD (CNY converted at the catalog rate), high fallbacks for models without one, by catalog id and by kind', () => {
    const t = pricesFromCatalog(BUILTIN_CATALOG);
    expect(DEFAULT_PRICES).toEqual(t);
    expect(t.anthropic!['claude-sonnet-5-5']).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, contextWindow: 1_000_000 });
    expect(t.anthropic!['claude-haiku-5-5']!.longContext).toEqual({ above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 });
    expect(t.deepseek!['deepseek-flash']).toMatchObject({ input: 0.3, output: 1.2, cacheRead: 0.006, contextWindow: 1_048_576 }); // CNY 2 / 8 / 0.04 at 0.15
    // no official price: the kind's deliberately high fallback, marked as such
    expect(t.moonshot!['kimi-k3.1-pro']).toMatchObject({ input: 5, output: 20, unverified: true, contextWindow: 1_048_576 });
    // a connection set up from a catalog provider finds its models by the catalog id
    const ledger = new CostLedger();
    ledger.setCatalogIds({ 'p-1': 'siliconflow' });
    expect(ledger.price('p-1', 'openai-compatible', 'deepseek-ai/DeepSeek-V4-Pro')).toMatchObject({ input: 1.8, output: 3.6 });
    expect(ledger.contextWindow('p-1', 'openai-compatible', 'zai-org/GLM-5.3')).toBe(1_048_576);
    expect(ledger.knownContextWindow('openai-compatible', 'doubao-seed-2-1-turbo-260628', 'ark')).toBe(262_144);
    expect(ledger.price('p-2', 'openai-compatible', 'nobody-knows-this')).toMatchObject({ unverified: true });
  });

  it('matches context windows by name when a relay spells the model differently, and says so; unknown names stay unknown', () => {
    const ledger = new CostLedger();
    expect(ledger.matchContextWindow('openai-compatible', 'deepseek-flash', 'deepseek')).toEqual({ contextWindow: 1_048_576, matched: 'deepseek-flash', how: 'exact' });
    expect(ledger.matchContextWindow('openai-compatible', 'DeepSeek-Flash')).toEqual({ contextWindow: 1_048_576, matched: 'deepseek-flash', how: 'name' });
    expect(ledger.matchContextWindow('openai-compatible', 'anthropic/Claude-Opus-5-5')).toEqual({ contextWindow: 1_000_000, matched: 'claude-opus-5-5', how: 'name' });
    expect(ledger.matchContextWindow('openai-compatible', 'relay/glm-5.3-flashx')).toEqual({ contextWindow: 1_000_000, matched: 'glm-5.3-flashx', how: 'name' });
    expect(ledger.matchContextWindow('openai-compatible', 'nobody-knows-this')).toBeNull();
    expect(ledger.matchContextWindow('openai-compatible', 'relay/nobody-knows-this')).toBeNull();
  });

  it('company presets come first; a newer valid update replaces the built-in list, an older or broken one does not', async () => {
    const c = effectiveCatalog(BUILTIN_CATALOG, undefined, PRESETS);
    expect(c.providers[0]).toMatchObject({ id: 'company-gateway', group: 'company', kind: 'wso2', listModels: 'none', default: true });
    expect(c.providers).toHaveLength(BUILTIN_CATALOG.providers.length + 1);
    const newer = { ...structuredClone(BUILTIN_CATALOG), version: '2027-01-15' };
    newer.providers = newer.providers.filter((p) => p.id !== 'openrouter');
    expect(effectiveCatalog(BUILTIN_CATALOG, newer).providers.some((p) => p.id === 'openrouter')).toBe(false);
    expect(effectiveCatalog(BUILTIN_CATALOG, { ...newer, version: '2026-01-01' }).providers.some((p) => p.id === 'openrouter')).toBe(true);

    const gw = await startGateway();
    try {
      const rt = makeRuntime(gw, { catalogPresets: PRESETS });
      expect(rt.catalog.providers[0]!.id).toBe('company-gateway');
      expect(rt.ledger.knownContextWindow('wso2', 'model-b', 'company-gateway')).toBe(200_000);
      expect(rt.setCatalog({ update: { ...newer, schema: 'nope' } })).toEqual([expect.stringMatching(/^model catalog update not used: schema must be/)]);
      expect(rt.catalog.version).toBe(BUILTIN_CATALOG.version);
      expect(rt.setCatalog({ update: newer })).toEqual([]);
      expect(rt.catalog.version).toBe('2027-01-15');
      await rt.close();
    } finally {
      await gw.stop();
    }
  });

  it('presets with mistakes are refused in plain words, keys never belong in them', () => {
    expect(presetProblems([{ id: 'g', name: 'G', kind: 'wso2', baseUrl: 'https://gw.example.internal/v1', consumerSecret: 'x', models: [{ id: 'm' }] }])).toEqual([
      'models[0] (g): tokenUrl (an http(s) address) is needed for wso2',
      'models[0] (g): consumerSecret must not be in the packaging (each person types their own)',
      'models[0] (g).models[0] (m): contextWindow must be a positive whole number',
    ]);
    expect(presetProblems({})).toEqual(['models must be a list of model connections']);
    expect(presetProblems(PRESETS)).toEqual([]);
  });
});

describe('get the models from the provider', () => {
  it('OpenAI style: context windows from the answer, else from the short list; non-chat models marked; hundreds of models', async () => {
    let auth = '';
    const many = Array.from({ length: 600 }, (_, i) => ({ id: `vendor/model-${String(i).padStart(3, '0')}`, context_length: 32_000 + i }));
    const base = await serve((req, res) => {
      auth = String(req.headers.authorization);
      if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro', context_window: 999_999 }, { id: 'text-embedding-x' }, ...many] });
      json(res, 404, {});
    });
    const r = await listProviderModels({ kind: 'openai-compatible', baseUrl: `${base}/v1`, apiKey: 'sk-list-test-123456', catalogId: 'deepseek' }, BUILTIN_CATALOG);
    expect(auth).toBe('Bearer sk-list-test-123456');
    if (!r.ok) throw new Error(r.message);
    expect(r.models).toHaveLength(603);
    expect(r.models.slice(0, 2)).toEqual([
      { id: 'deepseek-flash', contextWindow: 1_048_576, maxOutput: 384_000, inCatalog: true, chat: true }, // no window in the answer: the short list's
      { id: 'deepseek-v4-pro', contextWindow: 999_999, inCatalog: true, chat: true }, // the provider's own figure wins
    ]);
    expect(r.models.find((m) => m.id === 'text-embedding-x')).toEqual({ id: 'text-embedding-x', inCatalog: false, chat: false }); // no window known at all
    expect(r.models.find((m) => m.id === 'vendor/model-599')).toMatchObject({ contextWindow: 32_599, chat: true });
  });

  it('when it cannot: no such endpoint, a refused key, not JSON; the key never shows up in the answer', async () => {
    const base = await serve((req, res) => {
      if (req.url?.startsWith('/none')) return json(res, 404, { error: 'not found' });
      if (req.url?.startsWith('/key')) return json(res, 401, { error: { message: 'invalid key sk-list-test-123456' } });
      res.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
    });
    const ask = (path: string) => listProviderModels({ kind: 'openai-compatible', baseUrl: `${base}/${path}`, apiKey: 'sk-list-test-123456' }, BUILTIN_CATALOG);
    expect(await ask('none/v1')).toMatchObject({ ok: false, code: 'list.unsupported', hint: expect.stringMatching(/不提供型号列表/) });
    const refused = await ask('key/v1');
    expect(refused).toMatchObject({ ok: false, code: 'gateway.unauthorized', httpStatus: 401 });
    expect(JSON.stringify(refused)).not.toContain('sk-list-test-123456');
    expect(await ask('text/v1')).toMatchObject({ ok: false, code: 'list.bad_response' });
    // nothing listens there
    const s = createServer();
    const port = await listenFetchable(s);
    await new Promise((r) => s.close(r));
    expect(await listProviderModels({ kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1` }, BUILTIN_CATALOG)).toMatchObject({ ok: false, code: 'net.refused' });
  });

  it('Anthropic: its header, all pages, the context window it states', async () => {
    const seen: string[] = [];
    const base = await serve((req, res) => {
      seen.push(`${req.headers['x-api-key']} ${req.headers['anthropic-version']} ${req.url}`);
      if (req.url === '/v1/models?limit=1000') return json(res, 200, { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1_000_000, max_tokens: 128_000 }], has_more: true, last_id: 'claude-opus-5-5' });
      json(res, 200, { data: [{ id: 'claude-new-6', display_name: 'Claude New 6', max_input_tokens: 2_000_000 }], has_more: false, last_id: 'claude-new-6' });
    });
    const r = await listProviderModels({ kind: 'anthropic', baseUrl: `${base}/v1`, apiKey: 'sk-ant-test-123456', catalogId: 'anthropic' }, BUILTIN_CATALOG);
    expect(seen).toEqual(['sk-ant-test-123456 2023-06-01 /v1/models?limit=1000', 'sk-ant-test-123456 2023-06-01 /v1/models?limit=1000&after_id=claude-opus-5-5']);
    expect(r).toEqual({
      ok: true,
      models: [
        { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', contextWindow: 1_000_000, maxOutput: 128_000, inCatalog: true, chat: true },
        { id: 'claude-new-6', label: 'Claude New 6', contextWindow: 2_000_000, inCatalog: false, chat: true },
      ],
    });
  });

  it('WSO2: with a token first; a gateway without a model list says so', async () => {
    const base = await serve((req, res) => {
      if (req.url?.includes('token')) return json(res, 200, { access_token: 'tok-1', expires_in: 3600 });
      if (req.headers.authorization !== 'Bearer tok-1') return json(res, 401, {});
      json(res, 405, {});
    });
    const r = await listProviderModels(
      { kind: 'wso2', baseUrl: `${base}/v1`, oauth: { tokenUrl: `${base}/token`, clientId: 'ck-test-abcdef', clientSecret: 'cs-test-abcdef' }, catalogId: 'company-gateway' },
      effectiveCatalog(BUILTIN_CATALOG, undefined, PRESETS),
    );
    expect(r).toMatchObject({ ok: false, code: 'list.unsupported', httpStatus: 405 });
  });
});
