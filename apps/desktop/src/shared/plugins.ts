// What the settings page sees about plugins. Mirrors @spica/plugins'
// PluginDescription, trimmed to what the page shows, so the renderer does not
// import the plugin system itself.

export type ServerState = 'stopped' | 'starting' | 'running' | 'crashed' | 'failed' | string;

export interface PluginView {
  name: string;
  displayName: string;
  description: string;
  version: string;
  previousVersion?: string;
  enabled: boolean;
  /** Where it was installed from. */
  source?: { kind: 'folder' | 'zip' | 'share' | 'http'; location: string };
  mockSupported: boolean;
  skills: { id: string; name: string; description: string }[];
  commands: { id: string; description: string }[];
  /** Tools the agents can use right now (empty while off). */
  tools: string[];
  servers: { id: string; status: ServerState; tools: string[]; lastError?: string }[];
  /** Things to fix, in plain words. */
  issues: string[];
  /** A newer version found by "检查更新". */
  update?: string;
}

export interface PluginsState {
  plugins: PluginView[];
  /** Mock mode: plugins answer from bundled sample data instead of real systems. */
  mock: boolean;
  /** Where plugins live on this computer. */
  root: string;
  /** What "从这里装" found in a shared folder or index, waiting to be picked. */
  available?: { name: string; version: string; description?: string; key: string }[];
}

export type PluginsCommand =
  | { op: 'state' }
  | { op: 'enable' | 'disable' | 'uninstall' | 'rollback' | 'update'; name: string }
  | { op: 'mock'; on: boolean }
  /** A plugin folder, a .zip, a shared folder with index.json, or an http(s) address. */
  | { op: 'install'; location: string }
  /** One entry from `available`. */
  | { op: 'installAvailable'; key: string }
  | { op: 'checkUpdates' }
  | { op: 'openRoot' };

export interface PluginsResult {
  state: PluginsState;
  /** Plain-language outcome to show next to the action (success or problem). */
  message?: string;
  ok: boolean;
}
