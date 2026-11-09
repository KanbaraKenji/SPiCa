// The desktop shell's backend extension, loaded by the core like any other
// (BackendConfig.extensions, name '@spica/desktop-host'). It owns the one
// plugin manager (through @spica/plugins' own attachBackend, so Spica's MCP
// service keeps the plugin tools) and adds what only the shell needs:
//   plugins(cmd)                    the plugin page, incl. shared-folder / web sources and updates
//   setProviders(configs, current)  models from the settings page, applied without a restart
//   createSession(req)              new top-level sessions use the current default model
import { createProvider, type ProviderConfig, type Runtime } from '@spica/core';
import type { CreateSessionRequest } from '@spica/protocol';
import { attachBackend as attachPlugins } from '@spica/plugins';
import { RealPluginService } from '../main/plugins/service';
import type { PluginsCommand } from '../shared/plugins';

export interface DesktopHostOptions {
  pluginRoot: string;
  pluginSourcesFile: string;
  current: { providerId: string; model: string } | null;
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

  let current = options.current;
  return {
    mcpTools: plugins.mcpTools,
    warnings: plugins.warnings,
    methods: {
      ...plugins.methods,
      plugins: (cmd: unknown) => page.run(cmd as PluginsCommand),
      setProviders: (configs: unknown, cur: unknown) => {
        for (const c of (configs as ProviderConfig[]) ?? []) rt.addProvider(createProvider(c), c.limits);
        current = (cur as typeof current) ?? null;
        return true;
      },
      createSession: (req: unknown) => {
        const r = (req ?? {}) as CreateSessionRequest;
        if (r.providerId || r.parentId || !current) return rt.createSession(r).info();
        return rt.createSession({ ...r, providerId: current.providerId, model: current.model }).info();
      },
    },
    close: () => plugins.close(),
  };
}
