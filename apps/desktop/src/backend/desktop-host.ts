// The desktop shell's backend extension, loaded by the core like any other
// (BackendConfig.extensions, name '@spica/desktop-host'). It owns the one
// plugin manager (through @spica/plugins' own attachBackend, so Spica's MCP
// service keeps the plugin tools) and adds what only the shell needs:
//   plugins(cmd)                    the plugin page, incl. shared-folder / web sources and updates
//   workflows()                     what the core read from the workflow folder
// Models, mail and the workflow folder change through the core's own
// configure(patch) (no restart).
import type { Runtime } from '@spica/core';
import { attachBackend as attachPlugins } from '@spica/plugins';
import { RealPluginService } from '../main/plugins/service';
import type { PluginsCommand } from '../shared/plugins';

export interface DesktopHostOptions {
  pluginRoot: string;
  pluginSourcesFile: string;
}

interface ParentPort {
  postMessage(v: unknown): void;
}

export async function attachBackend(rt: Runtime, options: DesktopHostOptions) {
  const plugins = await attachPlugins(rt, { root: options.pluginRoot });
  const page = new RealPluginService({
    manager: plugins.manager,
    root: options.pluginRoot,
    sourcesFile: options.pluginSourcesFile,
    // Opening folders is the main process's job (it handles 'openRoot' itself).
    openFolder: async () => '',
  });
  // Tell the main process when plugins change on their own (a server crashed, ...).
  const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
  page.onChange(() => parent?.postMessage({ type: 'plugins.changed' }));

  return {
    mcpTools: plugins.mcpTools,
    warnings: plugins.warnings,
    methods: {
      ...plugins.methods,
      plugins: (cmd: unknown) => page.run(cmd as PluginsCommand),
      workflows: () => ({ names: [...rt.workflows.values()].map((w) => w.name), errors: [...rt.workflowErrors] }),
    },
    close: () => plugins.close(),
  };
}
