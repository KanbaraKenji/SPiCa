// The seam between the plugin page and whatever manages plugins.
import type { PluginsCommand, PluginsResult } from '../../shared/plugins';

export interface PluginService {
  /** Turns on the plugins that were on last time. */
  start(): Promise<void>;
  run(cmd: PluginsCommand): Promise<PluginsResult>;
  /** Called after anything changes on its own (a server crashed, a plugin was installed elsewhere). */
  onChange(listener: () => void): () => void;
  dispose(): Promise<void>;
}
