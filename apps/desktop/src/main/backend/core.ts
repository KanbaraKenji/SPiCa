// The real backend: @spica/core's Runtime behind the same AgentBackend seam.
// Model settings come from the developer's .env.local (ModelEnv) and from the
// providers saved on the settings page; keys stay in the main process.
import { AnthropicProvider, createAgentApi, OpenAICompatibleProvider, Runtime, SqliteStore, Wso2Provider, type Provider, type RetryPolicy } from '@spica/core';
import type { CreateSessionRequest } from '@spica/protocol';
import { createExtractors } from '@spica/extract';
import type { AgentBackend } from './types';
import type { ModelEnv } from './model-env';
import type { ResolvedProvider } from '../../shared/providers';

export interface CoreBackendOptions {
  env: ModelEnv;
  /** Working folder for sessions that do not name one. */
  cwd: string;
  /** SQLite file for sessions and history; in memory when omitted. */
  dbPath?: string;
}

/** Builds a core provider from saved settings, or explains why it cannot. */
export function buildProvider(p: ResolvedProvider, opts: { retry?: RetryPolicy } = {}): Provider | string {
  const retry = opts.retry ? { retry: opts.retry } : {};
  switch (p.kind) {
    case 'openai':
      return new OpenAICompatibleProvider({ id: p.id, baseUrl: p.baseUrl, apiKey: p.secret, ...retry });
    case 'anthropic':
      return new AnthropicProvider({ id: p.id, apiKey: p.secret, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), ...retry });
    case 'wso2':
      return new Wso2Provider({
        id: p.id,
        baseUrl: p.baseUrl,
        oauth: { tokenUrl: p.tokenUrl, clientId: p.clientId, clientSecret: p.secret, ...(p.scope ? { scope: p.scope } : {}) },
        ...retry,
      });
  }
}

export function createCoreBackend({ env, cwd, dbPath }: CoreBackendOptions): AgentBackend & { runtime: Runtime } {
  const providers: Provider[] = [];
  if (env.openai) providers.push(new OpenAICompatibleProvider({ id: 'openai', baseUrl: env.openai.baseUrl, apiKey: env.openai.apiKey }));
  if (env.anthropic) providers.push(new AnthropicProvider({ id: 'anthropic', apiKey: env.anthropic.apiKey }));
  const envModels: Record<string, string> = {};
  if (env.openai) envModels.openai = env.openai.model;
  if (env.anthropic) envModels.anthropic = env.anthropic.model;
  let current: { providerId: string; model: string } | undefined = env.openai
    ? { providerId: 'openai', model: env.openai.model }
    : env.anthropic
      ? { providerId: 'anthropic', model: env.anthropic.model }
      : undefined;
  const savedModels: Record<string, string> = {};

  const runtime = new Runtime({
    providers,
    // An empty provider id makes session creation fail with "unknown provider",
    // which the UI turns into "还没有配置这个模型".
    defaults: { providerId: current?.providerId ?? '', model: current?.model ?? '', maxTokens: 4096, maxTurns: 30 },
    cwd,
    // The interface is Chinese; the core tells the model to answer in the user's language.
    locale: 'zh-CN',
    // read_file understands PDF, Word, Excel, PowerPoint and CSV, and reports a file card for each.
    extractors: createExtractors(),
    ...(dbPath ? { store: new SqliteStore(dbPath) } : {}),
    // Development limits (see docs/design/agent-core.md §10): Anthropic 100 USD total, 2 USD per call.
    budget: { perProvider: { anthropic: { globalUsd: 100, perCallUsd: 2 } }, perRunUsd: 1 },
    limits: { openai: { maxConcurrent: 4, requestsPerMinute: 60 }, anthropic: { maxConcurrent: 2, requestsPerMinute: 30 } },
  });
  // Sessions, history, pending questions and confirmations survive a restart (or a crash).
  if (dbPath) runtime.restore();
  const api = createAgentApi(runtime);
  const offs: (() => void)[] = [];

  return {
    ...api,
    runtime,
    async createSession(req: CreateSessionRequest) {
      if (req.providerId || req.parentId || !current) return api.createSession(req);
      return api.createSession({ ...req, providerId: current.providerId, model: current.model });
    },
    onEvent(listener) {
      const off = runtime.events.on(listener);
      offs.push(off);
      return off;
    },
    configure(saved, defaultId) {
      const problems: { id: string; reason: string }[] = [];
      for (const p of saved) {
        const built = buildProvider(p);
        if (typeof built === 'string') {
          problems.push({ id: p.id, reason: built });
          continue;
        }
        const limits = {
          ...(p.maxConcurrent ? { maxConcurrent: p.maxConcurrent } : {}),
          ...(p.requestsPerMinute ? { requestsPerMinute: p.requestsPerMinute } : {}),
        };
        runtime.addProvider(built, limits);
        savedModels[p.id] = p.model;
      }
      const model = defaultId ? (savedModels[defaultId] ?? envModels[defaultId]) : undefined;
      if (defaultId && model) current = { providerId: defaultId, model };
      return problems;
    },
    dispose() {
      for (const s of runtime.sessions()) {
        try {
          s.abort();
        } catch {
          // Already stopped.
        }
      }
      for (const off of offs.splice(0)) off();
    },
  };
}
