// Backend selection. This is the only place that decides fake vs. real core.
//   SPICA_BACKEND=fake|core   force one; otherwise screenshots and tests use the
//   fake and a normal run uses the real core (with or without a model yet).
import type { AgentBackend } from './types';
import { FakeBackend, type FakeBackendOptions } from './fake';
import { createCoreBackend } from './core';
import type { ModelEnv } from './model-env';
import type { RuntimeLike } from '@spica/plugins';

export type { AgentBackend } from './types';

export type BackendKind = 'fake' | 'core';

export interface BackendChoice {
  requested?: string;
  automated: boolean;
}

export function chooseBackend({ requested, automated }: BackendChoice): BackendKind {
  if (requested === 'fake' || requested === 'core') return requested;
  return automated ? 'fake' : 'core';
}

/** The real core also hands out its runtime, which the plugin manager plugs into. */
export function createBackend(
  kind: BackendKind,
  opts: { fake?: FakeBackendOptions; env: ModelEnv; cwd: string; dbPath?: string },
): AgentBackend & { runtime?: RuntimeLike } {
  return kind === 'core' ? createCoreBackend({ env: opts.env, cwd: opts.cwd, ...(opts.dbPath ? { dbPath: opts.dbPath } : {}) }) : new FakeBackend(opts.fake);
}
