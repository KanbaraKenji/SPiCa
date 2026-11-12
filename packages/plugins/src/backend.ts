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
  /** Stopping a server also ends what it started (default true here; see PluginManagerOptions.endTree). */
  endTree?: boolean;
  /** App name in user-facing messages (a branded build passes its own). Default 'Spica'. */
  appName?: string;
  /** The user's account for every plugin (PluginManagerOptions.userAccount). Default ''. */
  userAccount?: string;
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
  // Page calls that gave a callId, so the shell can stop them when the page goes away.
  const viewCalls = new Map<string, AbortController>();
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
    // `callId` (optional, chosen by the shell) lets pluginViewCancel stop the call later.
    pluginViewCall: async (req) => {
      const r = (req ?? {}) as { plugin?: unknown; view?: unknown; tool?: unknown; args?: unknown; confirmed?: unknown; callId?: unknown };
      const args = r.args && typeof r.args === 'object' && !Array.isArray(r.args) ? (r.args as Record<string, unknown>) : {};
      const callId = typeof r.callId === 'string' && r.callId ? r.callId : undefined;
      const ctl = callId ? new AbortController() : undefined;
      if (callId && ctl) viewCalls.set(callId, ctl);
      try {
        return await pm.viewCall(String(r.plugin ?? ''), String(r.view ?? ''), String(r.tool ?? ''), args, {
          confirmed: r.confirmed === true,
          ...(ctl ? { signal: ctl.signal } : {}),
        });
      } finally {
        if (callId && viewCalls.get(callId) === ctl) viewCalls.delete(callId);
      }
    },
    // The page closed or reloaded while its call was running: stop it (the server is told to stop). False when unknown.
    pluginViewCancel: (req) => {
      const callId = String(((req ?? {}) as { callId?: unknown }).callId ?? '');
      const ctl = viewCalls.get(callId);
      if (!ctl) return false;
      viewCalls.delete(callId);
      ctl.abort();
      return true;
    },
    // Plugins using the user's models: why, the limit in force and today's spend; and the user's own limit.
    pluginModelUsage: () => pm.modelUsage(),
    pluginSetModelLimit: (req) => {
      const r = (req ?? {}) as { plugin?: unknown; maxUsdPerDay?: unknown };
      return pm.setModelLimit(String(r.plugin ?? ''), r.maxUsdPerDay === null || r.maxUsdPerDay === undefined ? null : Number(r.maxUsdPerDay));
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
  /** The host calls this after the network settings changed: plugin servers restart and pick them up. */
  networkChanged(): Promise<void>;
  /** The user changed the account (设置 › 账号): hooks see it at once, plugin servers restart with it. */
  setUserAccount(account: string): Promise<void>;
  close(): Promise<void>;
}> {
  if (!options?.root) throw new Error('plugins extension needs options.root');
  const pm = new PluginManager({
    host: runtimeHost(rt),
    root: options.root,
    ...(options.appName ? { appName: options.appName } : {}),
    ...(options.nodePath ? { nodePath: options.nodePath } : {}),
    ...(options.inheritEnv ? { inheritEnv: options.inheritEnv } : {}),
    ...(options.userAccount ? { userAccount: options.userAccount } : {}),
    endTree: options.endTree ?? true,
  });
  const loaded = await pm.load();
  if (options.mock !== undefined) await pm.setMock(options.mock);
  return {
    manager: pm,
    mcpTools: pluginMcpTools(pm),
    methods: pluginMethods(pm),
    warnings: loaded.failed.map((f) => `plugin ${f.name} was not enabled: ${f.message}`),
    networkChanged: () => pm.restartServers('network settings changed'),
    setUserAccount: (account: string) => pm.setUserAccount(account),
    close: () => pm.shutdown(),
  };
}
