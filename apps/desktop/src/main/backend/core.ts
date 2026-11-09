// The real backend: @spica/core's Runtime behind the same AgentBackend seam.
// Model settings come from ModelEnv (read by the main process only); keys never
// reach the renderer, logs or any file.
import { AnthropicProvider, createAgentApi, OpenAICompatibleProvider, Runtime, type Provider } from '@spica/core';
import type { AgentBackend } from './types';
import type { ModelEnv } from './model-env';

export interface CoreBackendOptions {
  env: ModelEnv;
  /** Working folder for sessions that do not name one. */
  cwd: string;
}

export function createCoreBackend({ env, cwd }: CoreBackendOptions): AgentBackend {
  const providers: Provider[] = [];
  if (env.openai) providers.push(new OpenAICompatibleProvider({ id: 'openai', baseUrl: env.openai.baseUrl, apiKey: env.openai.apiKey }));
  if (env.anthropic) providers.push(new AnthropicProvider({ id: 'anthropic', apiKey: env.anthropic.apiKey }));
  const first = env.openai ? { providerId: 'openai', model: env.openai.model } : { providerId: 'anthropic', model: env.anthropic?.model ?? '' };

  const runtime = new Runtime({
    providers,
    defaults: { providerId: first.providerId, model: first.model, maxTokens: 4096, maxTurns: 30 },
    cwd,
    // Development limits (see docs/design/agent-core.md §10): Anthropic 100 USD total, 2 USD per call.
    budget: { perProvider: { anthropic: { globalUsd: 100, perCallUsd: 2 } }, perRunUsd: 1 },
    limits: { openai: { maxConcurrent: 4, requestsPerMinute: 60 }, anthropic: { maxConcurrent: 2, requestsPerMinute: 30 } },
  });
  const api = createAgentApi(runtime);
  const offs: (() => void)[] = [];
  return {
    ...api,
    onEvent(listener) {
      const off = runtime.events.on(listener);
      offs.push(off);
      return off;
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
