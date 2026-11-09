// The one seam between the desktop shell and whatever runs the agents.
// Today `createBackend()` returns the fake; when @spica/core reaches its first
// milestone, a `CoreBackend` that wraps the real runtime implements the same
// interface and nothing else in the app changes.
import type { AgentApi, CoreEvent } from '@spica/protocol';

export interface AgentBackend extends AgentApi {
  /** Subscribe to every event of every session. Returns an unsubscribe function. */
  onEvent(listener: (event: CoreEvent) => void): () => void;
  /** Stop timers and runs; called when the app quits. */
  dispose(): void;
}
