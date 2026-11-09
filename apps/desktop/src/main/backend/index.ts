// Backend selection. This is the only place that decides fake vs. real core.
//   SPICA_BACKEND=fake|core   force one; otherwise: screenshots and tests use the
//   fake, a normal run uses the real core when a model is configured.
import type { AgentBackend } from './types';
import { FakeBackend, type FakeBackendOptions } from './fake';
import { createCoreBackend } from './core';
import { hasModel, type ModelEnv } from './model-env';

export type { AgentBackend } from './types';

export type BackendKind = 'fake' | 'core';

export interface BackendChoice {
  requested?: string;
  automated: boolean;
  env: ModelEnv;
}

export function chooseBackend({ requested, automated, env }: BackendChoice): BackendKind {
  if (requested === 'fake' || requested === 'core') return requested;
  if (automated) return 'fake';
  return hasModel(env) ? 'core' : 'fake';
}

export function createBackend(kind: BackendKind, opts: { fake?: FakeBackendOptions; env: ModelEnv; cwd: string }): AgentBackend {
  return kind === 'core' ? createCoreBackend({ env: opts.env, cwd: opts.cwd }) : new FakeBackend(opts.fake);
}
