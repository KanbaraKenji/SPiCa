// What the main process prepares for the backend process at every (re)start.
import type { BackendConfig } from '@spica/core';

export interface DesktopBackendConfig {
  /** Sent as the start message's config (providers, defaults, database, modules, extensions...). */
  core: BackendConfig;
  /** Default model for new top-level sessions; null when none is configured. */
  current: { providerId: string; model: string } | null;
}
