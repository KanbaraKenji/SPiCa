// Backend selection. This is the only file to change when the real core lands.
import type { AgentBackend } from './types';
import { FakeBackend, type FakeBackendOptions } from './fake';

export type { AgentBackend } from './types';

export function createBackend(options: FakeBackendOptions = {}): AgentBackend {
  return new FakeBackend(options);
}
