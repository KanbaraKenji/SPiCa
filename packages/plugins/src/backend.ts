// Backend extension: the plugin manager inside Spica's backend process, and
// its commands as tools on Spica's own MCP service (so J6 runs through MCP
// like the other journeys). Loaded by the core with a dynamic import, so the
// core does not depend on this package.
import { stat, readFile } from 'node:fs/promises';
import { runtimeHost, type RuntimeLike } from './host.ts';
import { PluginManager, type PluginDescription } from './manager.ts';
import { installZip } from './sources.ts';

/** Same shape as the core's MCP service tools. */
export interface McpServiceTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface PluginBackendOptions {
  /** Plugin root (installed plugins, data, logs, state.json). */
  root: string;
  /** Start with mock mode on (otherwise the saved setting is used). */
  mock?: boolean;
  nodePath?: string;
  inheritEnv?: string[];
}

const str = { type: 'string' } as const;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

/** Short form for lists. */
function brief(d: PluginDescription) {
  return { name: d.name, displayName: d.displayName, version: d.version, enabled: d.enabled, tools: d.tools, servers: d.servers.map((s) => `${s.id}:${s.status}`) };
}

export function pluginMcpTools(pm: PluginManager): McpServiceTool[] {
  const name = (args: Record<string, unknown>) => {
    if (typeof args.name !== 'string' || !args.name) throw new Error('name is required');
    return args.name;
  };
  return [
    {
      name: 'spica_plugins_list',
      description: 'Installed plugins: version, enabled, the tools each one adds right now.',
      inputSchema: obj({}),
      run: async () => ({ mock: pm.mock, plugins: pm.list().map(brief) }),
    },
    {
      name: 'spica_plugin_describe',
      description: 'Everything about one plugin: permissions, skills, commands, tools, hooks, processes, issues.',
      inputSchema: obj({ name: str }, ['name']),
      run: async (a) => pm.describe(name(a)),
    },
    {
      name: 'spica_plugin_install',
      description: 'Install or update a plugin from a folder or a .zip package on this computer. Set enable to turn it on at once.',
      inputSchema: obj({ path: str, enable: { type: 'boolean' } }, ['path']),
      run: async (a) => {
        const path = String(a.path ?? '');
        let isDir: boolean;
        try {
          isDir = (await stat(path)).isDirectory();
        } catch {
          throw new Error(`找不到 ${path}`);
        }
        let d = isDir ? await pm.install(path, { kind: 'folder', location: path }) : await installZip(pm, await readFile(path), { kind: 'zip', location: path });
        if (a.enable === true) d = await pm.enable(d.name);
        return d;
      },
    },
    {
      name: 'spica_plugin_enable',
      description: 'Turn a plugin on: its tools, skills and hooks become available at once.',
      inputSchema: obj({ name: str }, ['name']),
      run: async (a) => brief(await pm.enable(name(a))),
    },
    {
      name: 'spica_plugin_disable',
      description: 'Turn a plugin off: everything it registered is withdrawn and its processes stop.',
      inputSchema: obj({ name: str }, ['name']),
      run: async (a) => brief(await pm.disable(name(a))),
    },
    {
      name: 'spica_plugin_uninstall',
      description: 'Remove a plugin (its data folder is kept).',
      inputSchema: obj({ name: str }, ['name']),
      run: async (a) => {
        await pm.uninstall(name(a));
        return { ok: true };
      },
    },
    {
      name: 'spica_plugin_rollback',
      description: 'Switch a plugin back to the previously installed version.',
      inputSchema: obj({ name: str }, ['name']),
      run: async (a) => brief(await pm.rollback(name(a))),
    },
    {
      name: 'spica_plugins_set_mock',
      description: 'Turn global mock mode on or off (plugins answer from sample data).',
      inputSchema: obj({ on: { type: 'boolean' } }, ['on']),
      run: async (a) => {
        await pm.setMock(a.on === true);
        return { mock: pm.mock };
      },
    },
  ];
}

/** Methods on the backend port, for the desktop shell's plugin page. */
export function pluginMethods(pm: PluginManager): Record<string, (...params: unknown[]) => unknown> {
  return {
    pluginsList: () => pm.list(),
    pluginDescribe: (name) => pm.describe(String(name)),
    pluginCheck: (path) => pm.check(String(path)),
    pluginInstall: async (path) => {
      const p = String(path);
      return (await stat(p)).isDirectory() ? pm.install(p, { kind: 'folder', location: p }) : installZip(pm, await readFile(p), { kind: 'zip', location: p });
    },
    pluginEnable: (name) => pm.enable(String(name)),
    pluginDisable: (name) => pm.disable(String(name)),
    pluginUninstall: (name) => pm.uninstall(String(name)),
    pluginRollback: (name) => pm.rollback(String(name)),
    pluginsMock: () => pm.mock,
    pluginsSetMock: (on) => pm.setMock(on === true),
    pluginCommands: () => pm.commands(),
    pluginExpandCommand: (name, args) => pm.expandCommand(String(name), args === undefined ? '' : String(args)),
    // Plugin pages: the shell lists them, serves their files over its own
    // protocol and relays window.spica.callTool here.
    pluginViews: () => pm.views(),
    pluginViewFile: async (req) => {
      const r = (req ?? {}) as { plugin?: unknown; path?: unknown };
      return (await pm.resolveViewFile(String(r.plugin ?? ''), String(r.path ?? ''))) ?? null;
    },
    pluginViewCall: (req) => {
      const r = (req ?? {}) as { plugin?: unknown; view?: unknown; tool?: unknown; args?: unknown; confirmed?: unknown };
      const args = r.args && typeof r.args === 'object' && !Array.isArray(r.args) ? (r.args as Record<string, unknown>) : {};
      return pm.viewCall(String(r.plugin ?? ''), String(r.view ?? ''), String(r.tool ?? ''), args, { confirmed: r.confirmed === true });
    },
  };
}

/**
 * Entry point for the core's backend extensions: create the plugin manager,
 * re-enable what was enabled last time, and hand back the MCP tools.
 */
export async function attachBackend(
  rt: RuntimeLike,
  options: PluginBackendOptions,
): Promise<{
  manager: PluginManager;
  mcpTools: McpServiceTool[];
  methods: Record<string, (...params: unknown[]) => unknown>;
  warnings: string[];
  close(): Promise<void>;
}> {
  if (!options?.root) throw new Error('plugins extension needs options.root');
  const pm = new PluginManager({
    host: runtimeHost(rt),
    root: options.root,
    ...(options.nodePath ? { nodePath: options.nodePath } : {}),
    ...(options.inheritEnv ? { inheritEnv: options.inheritEnv } : {}),
  });
  const loaded = await pm.load();
  if (options.mock !== undefined) await pm.setMock(options.mock);
  return {
    manager: pm,
    mcpTools: pluginMcpTools(pm),
    methods: pluginMethods(pm),
    warnings: loaded.failed.map((f) => `plugin ${f.name} was not enabled: ${f.message}`),
    close: () => pm.shutdown(),
  };
}
