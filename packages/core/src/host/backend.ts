// Start the backend: providers from a JSON-able config, SQLite store with a
// single-writer lock, restore(), optional extractor modules. Used by the
// Electron utilityProcess entry and by the stdio MCP server.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BudgetConfig, PriceTable } from '../cost.ts';
import type { LimiterConfig } from '../limiter.ts';
import { AnthropicProvider } from '../providers/anthropic.ts';
import { OpenAICompatibleProvider } from '../providers/openai.ts';
import { probeProvider } from '../providers/probe.ts';
import { netHint } from '../net.ts';
import type { ProbeResult, UsageQuery } from '../types.ts';
import { summarizeRequests } from '../usage.ts';
import type { Provider } from '../providers/types.ts';
import { Wso2Provider } from '../providers/wso2.ts';
import { endsInVersion, joinUrl } from '../providers/http.ts';
import { Runtime } from '../runtime.ts';
import { SqliteStore } from '../store/sqlite.ts';
import type { FileExtractor } from '../tools/types.ts';
import { jsonSearchBackend, type JsonSearchBackendOptions } from '../tools/web-tools.ts';
import type { McpTool } from '../mcp/server.ts';
import { serveMcpHttp, type McpHttpServer } from '../mcp/http.ts';
import { configureNetwork, networkChildEnv, networkSecrets, networkStatus, type NetworkConfig } from '../net.ts';
import type { MailConfig } from '../mail.ts';
import { BackendServer } from './server.ts';
import { listProviderModels } from '../catalog/list-models.ts';

/** One model endpoint, as the settings page stores it (keys included; sent over the port, never via files or env). */
export interface ProviderConfig {
  id: string;
  kind: 'openai-compatible' | 'anthropic' | 'wso2';
  baseUrl?: string;
  apiKey?: string;
  /** Standalone mode: name of an environment variable holding the key (keeps keys out of config files). */
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  /** wso2 only. */
  oauth?: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string; credentialsIn?: 'basic' | 'body' };
  limits?: LimiterConfig;
  traceHost?: boolean;
  /** openai-compatible / wso2: extra body fields and reasoning echo options. */
  bodyDefaults?: Record<string, unknown>;
  reasoning?: { field?: string; echo?: 'never' | 'tool_turns' | 'always' };
  /** anthropic: model-hosted web search on/off. */
  webSearch?: boolean;
  /** The catalog provider (or company preset) it was set up from: prices and context windows of its models come from there. */
  catalogId?: string;
  /**
   * Context window per model name, in tokens (positive whole numbers). Wins over
   * what the price table knows; needs no price. A session reads it every time
   * its info is asked for, so a change applies without restarting.
   */
  contextWindows?: Record<string, number>;
  /** Most output tokens per model name, when the provider's own model list says it (wins over the catalog). */
  maxOutputs?: Record<string, number>;
}

/** Hand the providers' context windows to the ledger; providers not listed lose theirs. Returns warnings. */
function applyContextWindows(runtime: Runtime, providers: ProviderConfig[], previous: Iterable<string>): string[] {
  const warnings: string[] = [];
  const before = new Map(runtime.sessions().map((s) => [s, s.info().contextWindow]));
  const keep = new Set(providers.map((p) => p.id));
  for (const id of previous) {
    if (keep.has(id)) continue;
    runtime.ledger.setContextWindows(id, {});
    runtime.ledger.setMaxOutputs(id, {});
  }
  for (const p of providers) {
    runtime.ledger.setMaxOutputs(p.id, p.maxOutputs ?? {});
    const bad = runtime.ledger.setContextWindows(p.id, p.contextWindows ?? {});
    if (bad.length) warnings.push(`provider ${p.id}: context window ignored for ${bad.join(', ')} (needs a positive whole number of tokens)`);
  }
  // open sessions whose window changed tell the UI now, not at their next model call
  for (const [s, was] of before) {
    const info = s.info();
    if (info.contextWindow !== was) runtime.events.emit({ sessionId: s.id, parentChain: s.parentChain }, { type: 'session.updated', info });
  }
  return warnings;
}

export interface BackendConfig {
  /** SQLite file; a `<dbPath>.lock` file guards against a second writer. */
  dbPath: string;
  providers: ProviderConfig[];
  /** strongModel: the model for heavy work (plugins that ask for a strong model get it), on the default provider or on strongProviderId. */
  defaults: { providerId: string; model: string; maxTokens: number; maxTurns?: number; outputByModel?: boolean; agentMessages?: number; repeatRemind?: number; repeatStop?: number; strongModel?: string; strongProviderId?: string };
  cwd?: string;
  /**
   * The folder every conversation without a chosen one shared up to 0.1.0-rc.2 (the desktop app: Documents/<app>).
   * Conversations still working there can choose a folder once; their files stay there (RuntimeOptions.legacyDefaultCwd).
   */
  legacyDefaultCwd?: string;
  projectsRoot?: string;
  workflowsDir?: string;
  locale?: string;
  budget?: BudgetConfig;
  prices?: PriceTable;
  spillDir?: string;
  /** Product name the models are told they work in (see RuntimeOptions.appName). Default 'Spica'. */
  appName?: string;
  /** A company's model connections from the packaging's deploy.json (CatalogPreset[]; no keys). */
  catalogPresets?: unknown;
  search?: JsonSearchBackendOptions;
  /** Module specifiers that export createExtractors(): FileExtractor[] (e.g. '@spica/extract'). */
  extractorModules?: string[];
  /**
   * Modules that export attachBackend(runtime, options) (e.g. '@spica/plugins'),
   * called after restore(). Keeps the core free of a dependency on them.
   */
  extensions?: { module: string; options?: unknown }[];
  /** Mail pipeline; polling starts after the extensions are attached unless enabled is false. */
  mail?: MailConfig;
  /**
   * Also serve Spica's MCP service over HTTP (remote agent debugging). Loopback
   * only unless allowRemote; the bearer token comes from the environment
   * variable `tokenEnv` or is generated, and is written to `tokenFile` when given.
   */
  mcpHttp?: { port?: number; host?: string; allowRemote?: boolean; tokenEnv?: string; tokenFile?: string };
  /**
   * Proxy and extra trusted certificates for every outbound request (models,
   * token endpoints, web_fetch, web_search). What is left out comes from
   * HTTPS_PROXY / HTTP_PROXY / NO_PROXY and NODE_EXTRA_CA_CERTS.
   */
  network?: NetworkConfig;
  /** Spica's MCP service changing settings (spica_save_model, ...): whether each change waits for the user's confirmation. Default false (applied and shown in the conversations). */
  agentSettings?: { confirmChanges?: boolean };
  /** The user's memory across the assistant's conversations (RuntimeOptions.memory). Default on. */
  memory?: { enabled?: boolean; autoTidy?: boolean };
}

/** What attachBackend() of an extension module returns. */
export interface BackendExtension {
  /** Extra tools on Spica's MCP service. */
  mcpTools?: McpTool[];
  /** Extra methods on the backend port (for the desktop shell). */
  methods?: Record<string, (...params: unknown[]) => unknown>;
  warnings?: string[];
  /** Called on shutdown before the runtime closes (stop plugin processes, ...). */
  close?(): Promise<void>;
  /**
   * The network settings changed while running, in a way child processes see
   * (proxy, exceptions, trusted certificates: networkChildEnv). Processes read
   * them at start, so e.g. the plugin manager restarts its running servers.
   * Not called when only other settings changed. Errors are logged, not thrown.
   */
  networkChanged?(): void | Promise<void>;
}

/** The extensions attached to a runtime (for networkChanged). */
const attachedExtensions = new WeakMap<Runtime, BackendExtension[]>();

/** What of a provider configuration must be redacted: keys, secrets, endpoints, long header values. */
export function providerRedactions(c: ProviderConfig): (string | undefined)[] {
  return [
    c.apiKey,
    c.apiKeyEnv ? process.env[c.apiKeyEnv] : undefined,
    c.baseUrl,
    ...Object.values(c.headers ?? {}).filter((v) => v.length >= 12),
    c.oauth?.clientSecret,
    c.oauth?.clientId,
    c.oauth?.tokenUrl,
  ];
}

export function createProvider(c: ProviderConfig): Provider {
  switch (c.kind) {
    case 'anthropic':
      return new AnthropicProvider({
        id: c.id,
        ...(c.apiKey ? { apiKey: c.apiKey } : {}),
        ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
        ...(c.headers ? { headers: c.headers } : {}),
        ...(c.traceHost ? { traceHost: true } : {}),
        ...(c.webSearch !== undefined ? { webSearch: c.webSearch } : {}),
        ...(c.bodyDefaults ? { bodyDefaults: c.bodyDefaults } : {}),
      });
    case 'wso2':
      if (!c.baseUrl || !c.oauth) throw new Error(`provider ${c.id}: wso2 needs baseUrl and oauth`);
      return new Wso2Provider({
        id: c.id,
        baseUrl: c.baseUrl,
        oauth: c.oauth,
        ...(c.headers ? { headers: c.headers } : {}),
        ...(c.traceHost ? { traceHost: true } : {}),
        ...(c.bodyDefaults ? { bodyDefaults: c.bodyDefaults } : {}),
        ...(c.reasoning ? { reasoning: c.reasoning } : {}),
      });
    case 'openai-compatible':
      if (!c.baseUrl) throw new Error(`provider ${c.id}: baseUrl is required`);
      return new OpenAICompatibleProvider({
        id: c.id,
        baseUrl: c.baseUrl,
        ...(c.apiKey ? { apiKey: c.apiKey } : {}),
        ...(c.headers ? { headers: c.headers } : {}),
        ...(c.traceHost ? { traceHost: true } : {}),
        ...(c.bodyDefaults ? { bodyDefaults: c.bodyDefaults } : {}),
        ...(c.reasoning ? { reasoning: c.reasoning } : {}),
      });
    default:
      throw new Error(`provider ${(c as ProviderConfig).id}: unknown kind ${(c as ProviderConfig).kind}`);
  }
}

/**
 * Test connection with a configuration from the settings form or an agent. A
 * gateway that answers 404 to an address not ending in a version (/v1, /v2...)
 * often wants /v1: try once more with /v1 added. When that works the result
 * carries `suggestedBaseUrl` (the form puts it in and says so); when it does not,
 * the first 404 is reported with a hint to check the address's ending. Only the
 * test does this: requests of a conversation use the address as saved.
 */
export async function probeConfig(config: ProviderConfig, model: string, opts: { tracer?: Runtime['tracer']; timeoutMs?: number } = {}): Promise<ProbeResult> {
  const run = (c: ProviderConfig) => probeProvider(createProvider(c), { model, ...(opts.tracer ? { tracer: opts.tracer } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  const first = await run(config);
  const base = (config.baseUrl ?? '').replace(/\/+$/, '');
  const versioned = endsInVersion(base);
  if (first.ok || first.httpStatus !== 404 || first.stage !== 'model' || !base || versioned || config.kind === 'anthropic') return first;
  const suggested = joinUrl(base, '/v1');
  const again = await run({ ...config, baseUrl: suggested });
  if (again.ok) return { ...again, suggestedBaseUrl: suggested, code: 'address.v1_added', hint: netHint('address.v1_added', config.kind)! };
  return { ...first, code: 'gateway.not_found_version', hint: `模型调用失败：${netHint('gateway.not_found_version', config.kind)!}` };
}

/** Take the single-writer lock for a database; throws when another live process holds it. */
const heldHere = new Set<string>();

export function lockDatabase(dbPath: string): () => void {
  const key = resolve(dbPath).toLowerCase();
  if (heldHere.has(key)) throw Object.assign(new Error(`database ${dbPath} is already open in this process`), { code: 'locked' });
  mkdirSync(dirname(dbPath), { recursive: true });
  const lock = `${dbPath}.lock`;
  try {
    const fd = openSync(lock, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch {
    const pid = Number(readFileSync(lock, 'utf8').trim());
    let alive = false;
    try {
      if (pid && pid !== process.pid) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      alive = false;
    }
    if (alive) throw Object.assign(new Error(`database ${dbPath} is in use by process ${pid}`), { code: 'locked' });
    writeFileSync(lock, String(process.pid)); // stale lock from a crashed process
  }
  heldHere.add(key);
  return () => {
    heldHere.delete(key);
    rmSync(lock, { force: true });
  };
}

/** What the settings page can change while the backend runs (all optional). */
export interface SettingsPatch {
  /** The complete provider list: new ones are added, changed ones replaced, missing ones removed. */
  providers?: ProviderConfig[];
  defaults?: Partial<BackendConfig['defaults']>;
  budget?: BudgetConfig;
  prices?: PriceTable;
  workflowsDir?: string;
  locale?: string;
  /** null removes web_search. */
  search?: JsonSearchBackendOptions | null;
  mail?: Omit<MailConfig, 'sources'>;
  /** Proxy / certificates; applies to the next request. */
  network?: NetworkConfig;
  agentSettings?: BackendConfig['agentSettings'];
  /** The memory switch in the settings (off: conversations neither read nor save it; what is saved stays). */
  memory?: { enabled?: boolean; autoTidy?: boolean };
  /** A newer model catalog (from the update source); used when valid and newer than the built-in one. */
  catalog?: unknown;
}

/** The provider configurations a runtime runs with now (secrets included; never leaves the backend). */
const runningConfigs = new WeakMap<Runtime, Map<string, ProviderConfig>>();

function rememberConfigs(runtime: Runtime, providers: ProviderConfig[]): void {
  runningConfigs.set(runtime, new Map(providers.map((p) => [p.id, p])));
  runtime.ledger.setCatalogIds(Object.fromEntries(providers.filter((p) => p.catalogId).map((p) => [p.id, p.catalogId!])));
}

/** Apply a settings patch to a running runtime; emits runtime.configured. */
export function applySettings(runtime: Runtime, patch: SettingsPatch): { changed: string[]; warnings: string[] } {
  const changed: string[] = [];
  const warnings: string[] = [];
  if (patch.providers) {
    const keep = new Set(patch.providers.map((p) => p.id));
    const previous = [...runtime.providerIds];
    for (const c of patch.providers) {
      runtime.addRedactions(providerRedactions(c));
      runtime.setProvider(createProvider(c), c.limits ?? {});
    }
    for (const id of runtime.providerIds) if (!keep.has(id)) runtime.removeProvider(id);
    warnings.push(...applyContextWindows(runtime, patch.providers, previous));
    rememberConfigs(runtime, patch.providers);
    changed.push('providers');
  }
  if (patch.defaults) {
    runtime.setDefaults(patch.defaults);
    changed.push('defaults');
  }
  if (patch.budget) {
    runtime.ledger.setBudget(patch.budget);
    changed.push('budget');
  }
  if (patch.prices) {
    runtime.ledger.setPrices(patch.prices);
    changed.push('prices');
  }
  if (patch.workflowsDir !== undefined) {
    warnings.push(...runtime.reloadWorkflows(patch.workflowsDir));
    changed.push('workflows');
  }
  if (patch.locale) {
    runtime.setLocale(patch.locale);
    changed.push('locale');
  }
  if (patch.search !== undefined) {
    runtime.setSearch(patch.search ? jsonSearchBackend(patch.search) : undefined);
    changed.push('search');
  }
  if (patch.mail) {
    runtime.mail.configure(patch.mail);
    changed.push('mail');
  }
  if (patch.network) {
    const before = JSON.stringify(networkChildEnv());
    warnings.push(...configureNetwork(patch.network).warnings);
    runtime.addRedactions(networkSecrets());
    changed.push('network');
    if (JSON.stringify(networkChildEnv()) !== before) {
      for (const ext of attachedExtensions.get(runtime) ?? []) {
        try {
          void Promise.resolve(ext.networkChanged?.()).catch((err: unknown) => console.error(`networkChanged failed: ${err instanceof Error ? err.message : String(err)}`));
        } catch (err) {
          console.error(`networkChanged failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  if (patch.catalog !== undefined) {
    warnings.push(...runtime.setCatalog({ update: patch.catalog }));
    changed.push('catalog');
  }
  if (patch.memory) {
    if (patch.memory.enabled !== undefined) runtime.memory.setEnabled(patch.memory.enabled);
    if (patch.memory.autoTidy !== undefined) runtime.memory.setAutoTidy(patch.memory.autoTidy);
    changed.push('memory');
  }
  if (patch.agentSettings?.confirmChanges !== undefined) {
    runtime.confirmSettingsChanges = patch.agentSettings.confirmChanges;
    changed.push('agentSettings');
  }
  runtime.events.emit(runtime.eventHost, { type: 'runtime.configured', changed, warnings });
  return { changed, warnings };
}

export interface Backend {
  runtime: Runtime;
  server: BackendServer;
  restored: ReturnType<Runtime['restore']>;
  warnings: string[];
  /** Tools contributed by extensions, for serveMcp({ extraTools }). */
  mcpTools: McpTool[];
  /** The HTTP MCP service when `mcpHttp` is configured (holds the token: do not log it). */
  mcpHttp?: McpHttpServer;
  close(): Promise<void>;
}

/**
 * Code the host links in directly. `modules` maps the names used in
 * `extractorModules` / `extensions[].module` to already-imported modules, so a
 * packaged app (no node_modules) does not depend on dynamic import by package
 * name; names missing here are imported by name (development).
 */
export interface BackendHost {
  modules?: Record<string, unknown>;
}

export async function startBackend(cfg: BackendConfig, host: BackendHost = {}): Promise<Backend> {
  const load = async (spec: string): Promise<unknown> => host.modules?.[spec] ?? (await import(spec));
  const unlock = lockDatabase(cfg.dbPath);
  try {
    const warnings: string[] = [...configureNetwork(cfg.network ?? {}).warnings];
    const extractors: FileExtractor[] = [];
    for (const spec of cfg.extractorModules ?? []) {
      try {
        const mod = (await load(spec)) as { createExtractors?: () => FileExtractor[] };
        if (typeof mod.createExtractors === 'function') extractors.push(...mod.createExtractors());
        else warnings.push(`extractor module ${spec} has no createExtractors()`);
      } catch (err) {
        warnings.push(`extractor module ${spec} could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const providers = cfg.providers.map(createProvider);
    const runtime = new Runtime({
      providers,
      redactions: cfg.providers.flatMap(providerRedactions),
      defaults: cfg.defaults,
      store: new SqliteStore(cfg.dbPath),
      limits: Object.fromEntries(cfg.providers.filter((p) => p.limits).map((p) => [p.id, p.limits!])),
      extractors,
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
      ...(cfg.projectsRoot ? { projectsRoot: cfg.projectsRoot } : {}),
      ...(cfg.workflowsDir ? { workflowsDir: cfg.workflowsDir } : {}),
      ...(cfg.locale ? { locale: cfg.locale } : {}),
      ...(cfg.budget ? { budget: cfg.budget } : {}),
      ...(cfg.prices ? { prices: cfg.prices } : {}),
      ...(cfg.spillDir ? { spillDir: cfg.spillDir } : {}),
      ...(cfg.appName ? { appName: cfg.appName } : {}),
      // attached images live next to the database (one folder per conversation)
      mediaDir: join(dirname(cfg.dbPath), 'media'),
      // a conversation started without a folder gets its own one next to the database, not under Documents
      sessionFilesDir: join(dirname(cfg.dbPath), 'sessions'),
      ...(cfg.legacyDefaultCwd ? { legacyDefaultCwd: cfg.legacyDefaultCwd } : {}),
      ...(cfg.search ? { search: jsonSearchBackend(cfg.search) } : {}),
      ...(cfg.mail ? { mail: cfg.mail } : {}),
      ...(cfg.memory ? { memory: cfg.memory } : {}),
    });
    warnings.push(...runtime.workflowErrors);
    warnings.push(...applyContextWindows(runtime, cfg.providers, []));
    runtime.addRedactions(networkSecrets());
    rememberConfigs(runtime, cfg.providers);
    if (cfg.catalogPresets !== undefined) warnings.push(...runtime.setCatalog({ presets: cfg.catalogPresets }));
    if (cfg.agentSettings?.confirmChanges !== undefined) runtime.confirmSettingsChanges = cfg.agentSettings.confirmChanges;
    // the settings tools on Spica's MCP service reach the window's settings through the port (server is set below)
    const port: { server?: BackendServer } = {};
    runtime.settingsBridge = {
      host: (method, params = []) => (port.server ? port.server.callHost(method, params) : Promise.reject(Object.assign(new Error('backend starting'), { code: 'host_unavailable' }))),
      probe: (config, model) => probeConfig(config, model, { tracer: runtime.tracer }),
      providerConfig: (id) => runningConfigs.get(runtime)?.get(id),
      network: () => networkStatus(),
    };
    const restored = runtime.restore();
    const extensions: BackendExtension[] = [];
    attachedExtensions.set(runtime, extensions);
    for (const ext of cfg.extensions ?? []) {
      try {
        const mod = (await load(ext.module)) as { attachBackend?: (rt: Runtime, options: unknown) => BackendExtension | Promise<BackendExtension> };
        if (typeof mod.attachBackend !== 'function') {
          warnings.push(`extension ${ext.module} has no attachBackend()`);
          continue;
        }
        const attached = await mod.attachBackend(runtime, ext.options);
        extensions.push(attached);
        warnings.push(...(attached.warnings ?? []));
      } catch (err) {
        warnings.push(`extension ${ext.module} could not be attached: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // off unless the user turned it on: polling sends mail content to the configured model
    if (cfg.mail?.enabled === true) runtime.mail.start();
    // 自动整理 checks now and then (it only tidies when switched on)
    runtime.memory.startAutoTidy();
    const mcpTools = extensions.flatMap((e) => e.mcpTools ?? []);
    let mcpHttp: McpHttpServer | undefined;
    if (cfg.mcpHttp) {
      const h = cfg.mcpHttp;
      const envToken = h.tokenEnv ? process.env[h.tokenEnv] : undefined;
      try {
        mcpHttp = await serveMcpHttp(runtime, {
          extraTools: mcpTools,
          ...(h.host ? { host: h.host } : {}),
          ...(h.port !== undefined ? { port: h.port } : {}),
          ...(h.allowRemote ? { allowRemote: true } : {}),
          ...(envToken ? { token: envToken } : {}),
        });
        if (h.tokenFile) {
          mkdirSync(dirname(h.tokenFile), { recursive: true });
          writeFileSync(h.tokenFile, mcpHttp.token, { mode: 0o600 });
        }
      } catch (err) {
        warnings.push(`MCP over HTTP not started: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const server = new BackendServer(runtime, {
      extraMethods: {
        ...Object.assign({}, ...extensions.map((e) => e.methods ?? {})),
        /** Change settings without restarting (see SettingsPatch). */
        configure: (patch: unknown) => applySettings(runtime, (patch ?? {}) as SettingsPatch),
        /** Where the HTTP MCP service listens (never the token), or null. */
        mcpHttp: () => (mcpHttp ? { url: mcpHttp.url, tokenFile: cfg.mcpHttp?.tokenFile ?? null } : null),
        /** Proxy and certificates in force (no password). */
        networkSettings: () => networkStatus(),
        /** Current mail settings and whether polling runs. */
        mailSettings: () => ({ ...runtime.mail.settings, running: runtime.mail.running, sources: runtime.mail.activeSources.map((s) => s.id) }),
        /** Test connection with a provider config from the settings form. */
        probeProvider: (config: unknown, model: unknown) => probeConfig(config as ProviderConfig, String(model), { tracer: runtime.tracer }),
        /** The usage page: the request log summed up per time bucket, provider and model, and the 429 answers (see UsageQuery). */
        usageSummary: (query: unknown) => {
          const q = (query ?? {}) as UsageQuery;
          const range = { fromMs: Date.parse(String(q.from)), toMs: Date.parse(String(q.to)) };
          if (Number.isNaN(range.fromMs) || Number.isNaN(range.toMs)) throw new Error('from / to must be ISO 8601 dates');
          return summarizeRequests(runtime.store.listRequests(range), q, runtime.store.firstRequestAt());
        },
        /** The newest request records, oldest first (the monitor fills its list with them when it opens). */
        recentRequests: (limit: unknown) => runtime.store.listRequests({ limit: Math.min(5000, Math.max(0, Number(limit) || 500)), newest: true }),
        /** What each provider has cost so far (USD; every conversation, back from the stored records; models without a price add nothing). */
        providerSpend: (ids: unknown) => Object.fromEntries((Array.isArray(ids) ? ids : []).map((id) => [String(id), runtime.ledger.providerUsd(String(id))])),
        /** Context window the core knows for a model (to pre-fill the settings form), or null. kind: ProviderConfig kind. */
        knownContextWindow: (kind: unknown, model: unknown, catalogId?: unknown) =>
          runtime.ledger.knownContextWindow(String(kind), String(model), typeof catalogId === 'string' ? catalogId : undefined),
        /** Like knownContextWindow, also when a relay spells the name differently: { contextWindow, matched, how: 'exact' | 'name' } or null. */
        matchContextWindow: (kind: unknown, model: unknown, catalogId?: unknown) =>
          runtime.ledger.matchContextWindow(String(kind), String(model), typeof catalogId === 'string' ? catalogId : undefined),
        /** What a conversation's context is made of (the detail under the context ring), without a model call; null for an unknown session. */
        contextBreakdown: (sessionId: unknown) => runtime.session(String(sessionId))?.contextBreakdown() ?? null,
        /** The user looked at a project's updates: its unread count goes back to 0 (emits project.updated). */
        markProjectRead: (projectId: unknown) => runtime.markProjectRead(String(projectId)),
        /** Whether a configured model takes images: true / false (catalog, or it refused them), null when not known (images are sent). */
        modelTakesImages: (providerId: unknown, model: unknown) => runtime.imagesAllowed(String(providerId), String(model)) ?? null,
        /** The model catalog for the settings form: providers (company presets first), addresses, models, context windows, official prices. */
        modelCatalog: () => runtime.catalog,
        /** "Get the models from the provider" for a connection being set up (the key is used for this request only). */
        listProviderModels: (config: unknown) => {
          const c = config as ProviderConfig;
          runtime.addRedactions(providerRedactions(c));
          return listProviderModels(
            {
              kind: c.kind,
              ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
              ...(c.apiKey ? { apiKey: c.apiKey } : {}),
              ...(c.oauth ? { oauth: c.oauth } : {}),
              ...(c.headers ? { headers: c.headers } : {}),
              ...(c.catalogId ? { catalogId: c.catalogId } : {}),
            },
            runtime.catalog,
          );
        },
      },
    });
    port.server = server;
    let closed = false;
    return {
      runtime,
      server,
      restored,
      warnings,
      mcpTools,
      ...(mcpHttp ? { mcpHttp } : {}),
      close: async () => {
        if (closed) return;
        closed = true;
        server.close();
        await mcpHttp?.close();
        for (const e of extensions) await e.close?.().catch(() => undefined);
        await runtime.close();
        unlock();
      },
    };
  } catch (err) {
    unlock();
    throw err;
  }
}
