// The typed bridge the renderer sees as `window.spica`. Everything the UI can
// do goes through here; there is no other way to reach the backend.
import type { AgentApi, CoreEvent, SpicaBridge } from '@spica/protocol';
import type { SettingsPatch, ShellSettings } from './settings';

export interface ShellState {
  settings: ShellSettings;
  /** OS prefers dark (used when the skin follows the system). */
  systemDark: boolean;
  /** True when no model is configured and the conversation runs on demo data. */
  demo: boolean;
}

export interface DesktopBridge extends SpicaBridge {
  /** The agent backend (fake until the core's first milestone; same interface either way). */
  agent: AgentApi;
  onAgentEvent(listener: (event: CoreEvent) => void): () => void;
  getShellState(): Promise<ShellState>;
  updateSettings(patch: SettingsPatch): Promise<ShellSettings>;
  onSettingsChanged(listener: (settings: ShellSettings) => void): () => void;
  /** Opens a file a session referenced (relative to its working folder). Resolves to an error text, or null on success. */
  openFile(sessionId: string, path: string): Promise<string | null>;
}
