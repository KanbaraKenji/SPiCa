// What the main process sends the backend process at start.
import type { BackendConfig } from '@spica/core';

export interface DesktopBackendConfig {
  /** Passed to startBackend (providers, defaults, database, folders, budget...). */
  core: BackendConfig;
  /** Default model for new top-level sessions; null when none is configured. */
  current: { providerId: string; model: string } | null;
  /** %APPDATA%\Spica\plugins */
  pluginRoot: string;
  /** Where the plugin page remembers shared folders / index URLs. */
  pluginSourcesFile: string;
}
