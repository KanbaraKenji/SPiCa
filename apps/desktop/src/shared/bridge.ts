// The typed bridge the renderer sees as `window.spica`. Everything the UI can
// do goes through here; there is no other way to reach the backend.
import type { AgentApi, CoreEvent, SpicaBridge } from '@spica/protocol';
import type { SettingsPatch, ShellSettings } from './settings';
import type { ProviderDraft, ProviderView, TestResult } from './providers';
import type { PluginsCommand, PluginsResult } from './plugins';

/** Saved model providers plus, per id, why one cannot be used right now. */
export interface ProviderList {
  items: ProviderView[];
  problems: Record<string, string>;
}

export interface ShellState {
  settings: ShellSettings;
  /** OS prefers dark (used when the skin follows the system). */
  systemDark: boolean;
  /** True when the conversation runs on demo data (screenshots, tests, SPICA_BACKEND=fake). */
  demo: boolean;
  /** A script drives the window (screenshots): skip the opening animation. */
  automated: boolean;
}

export interface DesktopBridge extends SpicaBridge {
  /** The agent backend (fake until the core's first milestone; same interface either way). */
  agent: AgentApi;
  onAgentEvent(listener: (event: CoreEvent) => void): () => void;
  getShellState(): Promise<ShellState>;
  updateSettings(patch: SettingsPatch): Promise<ShellSettings>;
  onSettingsChanged(listener: (settings: ShellSettings) => void): () => void;
  /** One zoom step for the whole window (Ctrl+wheel, Ctrl+=/-/0). */
  zoom(step: 'in' | 'out' | 'reset'): void;
  /** Opens a file a session referenced (relative to its working folder). Resolves to an error text, or null on success. */
  openFile(sessionId: string, path: string): Promise<string | null>;
  /** Windows' own folder picker. Resolves to the chosen path, or null when cancelled. */
  pickFolder(): Promise<string | null>;
  plugins: {
    run(cmd: PluginsCommand): Promise<PluginsResult>;
    onChanged(listener: () => void): () => void;
  };
  providers: {
    list(): Promise<ProviderList>;
    /** Saves (new when draft.id is empty). Rejects with a plain-language message. */
    save(draft: ProviderDraft): Promise<ProviderList>;
    remove(id: string): Promise<ProviderList>;
    setDefault(id: string): Promise<ProviderList>;
    test(draft: ProviderDraft): Promise<TestResult>;
  };
}
