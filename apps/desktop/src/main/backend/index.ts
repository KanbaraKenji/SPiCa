// Backend selection. This is the only place that decides fake vs. real core.
//   SPICA_BACKEND=fake|core   force one; otherwise screenshots and tests use the
//   fake and a normal run uses the real core in its own process.
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
