// The one seam between the desktop shell and whatever runs the agents:
// CoreBackend (the real @spica/core runtime) or FakeBackend (scripted, for
// screenshots and tests). Nothing else in the app knows which one it talks to.
import type { AgentApi, CoreEvent } from '@spica/protocol';
import type { ResolvedProvider } from '../../shared/providers';
import type { PythonState } from '../../shared/bridge';

export interface AgentBackend extends AgentApi {
  /** Subscribe to every event of every session. Returns an unsubscribe function. */
  onEvent(listener: (event: CoreEvent) => void): () => void;
  /** Stop timers and runs; called when the app quits. */
  dispose(): void;
  /**
   * Use these saved providers; new sessions go to `defaultId` (a saved id, or an
   * id the backend already knows). Returns ids it could not use, with a reason.
   */
  configure?(providers: ResolvedProvider[], defaultId: string | null): { id: string; reason: string }[];
  /** The app's own Python for 设置 › 常规 (null: switched off). */
  pythonState?(): Promise<PythonState | null>;
  /** Remove the app's own Python; its state after. */
  pythonClear?(): Promise<PythonState | null>;
}
