// Start the backend: providers from a JSON-able config, SQLite store with a
// single-writer lock, restore(), optional extractor modules. Used by the
// Electron utilityProcess entry and by the stdio MCP server.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BudgetConfig, PriceTable } from '../cost.ts';
import type { LimiterConfig } from '../limiter.ts';
import { AnthropicProvider } from '../providers/anthropic.ts';
import { OpenAICompatibleProvider } from '../providers/openai.ts';
import { probeProvider } from '../providers/probe.ts';
import type { Provider } from '../providers/types.ts';
import { Wso2Provider } from '../providers/wso2.ts';
import { Runtime } from '../runtime.ts';
import { SqliteStore } from '../store/sqlite.ts';
import type { FileExtractor } from '../tools/types.ts';
import { jsonSearchBackend, type JsonSearchBackendOptions } from '../tools/web-tools.ts';
import type { McpTool } from '../mcp/server.ts';
import { serveMcpHttp, type McpHttpServer } from '../mcp/http.ts';
import { configureNetwork, networkStatus, type NetworkConfig } from '../net.ts';
import type { MailConfig } from '../mail.ts';
import { BackendServer } from './server.ts';

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
  /**
   * Context window per model name, in tokens (positive whole numbers). Wins over
   * what the price table knows; needs no price. A session reads it every time
   * its info is asked for, so a change applies without restarting.
   */
  contextWindows?: Record<string, number>;
}

/** Hand the providers' context windows to the ledger; providers not listed lose theirs. Returns warnings. */
function applyContextWindows(runtime: Runtime, providers: ProviderConfig[], previous: Iterable<string>): string[] {
  const warnings: string[] = [];
  const before = new Map(runtime.sessions().map((s) => [s, s.info().contextWindow]));
  const keep = new Set(providers.map((p) => p.id));
  for (const id of previous) if (!keep.has(id)) runtime.ledger.setContextWindows(id, {});
  for (const p of providers) {
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
  defaults: { providerId: string; model: string; maxTokens: number; maxTurns?: number };
  cwd?: string;
  projectsRoot?: string;
  workflowsDir?: string;
  locale?: string;
  budget?: BudgetConfig;
  prices?: PriceTable;
  spillDir?: string;
  /** Product name the models are told they work in (see RuntimeOptions.appName). Default 'Spica'. */
  appName?: string;
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
}

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
}

/** The provider configurations a runtime runs with now (secrets included; never leaves the backend). */
const runningConfigs = new WeakMap<Runtime, Map<string, ProviderConfig>>();

function rememberConfigs(runtime: Runtime, providers: ProviderConfig[]): void {
  runningConfigs.set(runtime, new Map(providers.map((p) => [p.id, p])));
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
    warnings.push(...configureNetwork(patch.network).warnings);
    changed.push('network');
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
      ...(cfg.search ? { search: jsonSearchBackend(cfg.search) } : {}),
      ...(cfg.mail ? { mail: cfg.mail } : {}),
    });
    warnings.push(...runtime.workflowErrors);
    warnings.push(...applyContextWindows(runtime, cfg.providers, []));
    rememberConfigs(runtime, cfg.providers);
    if (cfg.agentSettings?.confirmChanges !== undefined) runtime.confirmSettingsChanges = cfg.agentSettings.confirmChanges;
    // the settings tools on Spica's MCP service reach the window's settings through the port (server is set below)
    const port: { server?: BackendServer } = {};
    runtime.settingsBridge = {
      host: (method, params = []) => (port.server ? port.server.callHost(method, params) : Promise.reject(Object.assign(new Error('backend starting'), { code: 'host_unavailable' }))),
      probe: (config, model) => probeProvider(createProvider(config), { model, tracer: runtime.tracer }),
      providerConfig: (id) => runningConfigs.get(runtime)?.get(id),
      network: () => networkStatus(),
    };
    const restored = runtime.restore();
    const extensions: BackendExtension[] = [];
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
        probeProvider: (config: unknown, model: unknown) =>
          probeProvider(createProvider(config as ProviderConfig), { model: String(model), tracer: runtime.tracer }),
        /** Context window the core knows for a model (to pre-fill the settings form), or null. kind: ProviderConfig kind. */
        knownContextWindow: (kind: unknown, model: unknown) => runtime.ledger.knownContextWindow(String(kind), String(model)),
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
