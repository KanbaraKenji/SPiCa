// The desktop shell's backend extension, loaded by the core like any other
// (BackendConfig.extensions, name '@spica/desktop-host'). It owns the one
// plugin manager (through @spica/plugins' own attachBackend, so Spica's MCP
// service keeps the plugin tools) and adds what only the shell needs:
//   plugins(cmd)                    the plugin page, incl. shared-folder / web sources and updates
//   workflows()                     what the core read from the workflow folder
//   usageLog({ filter, file })      the core's usage log written to a file (设置 › 常规)
//   mcpHttpStart / Stop / State     Spica's MCP service over HTTP for scripts on this machine
//                                   (设置 › 常规 › 开发者; loopback only, token in a file)
// Models, mail and the workflow folder change through the core's own
// configure(patch) (no restart).
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { serveMcpHttp, type McpHttpServer, type Runtime } from '@spica/core';
import { attachBackend as attachPlugins } from '@spica/plugins';
import { RealPluginService } from '../main/plugins/service';
import type { PluginsCommand } from '../shared/plugins';
import { APP_NAME } from '../shared/app-identity';

export interface DesktopHostOptions {
  pluginRoot: string;
  pluginSourcesFile: string;
  /** Where local scripts find the HTTP MCP service ({ url, tokenFile, pid, startedAt, appName }); absent: no such service. */
  mcpInfoFile?: string;
  /** The bearer token, one line, readable by this user only. */
  mcpTokenFile?: string;
}

/** Tried first, so scripts usually find the same address; any free port when it is taken. */
export const MCP_HTTP_PORT = 47820;

interface ParentPort {
  postMessage(v: unknown): void;
}

export async function attachBackend(rt: Runtime, options: DesktopHostOptions) {
  const plugins = await attachPlugins(rt, { root: options.pluginRoot, appName: APP_NAME });
  const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
  const page = new RealPluginService({
    manager: plugins.manager,
    root: options.pluginRoot,
    sourcesFile: options.pluginSourcesFile,
    // Opening folders is the main process's job (it handles 'openRoot' itself).
    openFolder: async () => '',
    // How far an install the page started is, on its way to the window.
    onProgress: (progress) => parent?.postMessage({ type: 'plugins.progress', progress }),
  });
  // Tell the main process when plugins change on their own (a server crashed, ...).
  page.onChange(() => parent?.postMessage({ type: 'plugins.changed' }));

  let http: McpHttpServer | undefined;
  const httpState = () => (http ? { url: http.url, port: http.port, tokenFile: options.mcpTokenFile ?? null } : null);
  const stopHttp = async () => {
    const h = http;
    http = undefined;
    if (options.mcpInfoFile) await rm(options.mcpInfoFile, { force: true }).catch(() => undefined);
    await h?.close().catch(() => undefined);
  };
  const startHttp = async () => {
    if (http || !options.mcpInfoFile || !options.mcpTokenFile) return httpState();
    const opts = { extraTools: plugins.mcpTools, host: '127.0.0.1' };
    try {
      http = await serveMcpHttp(rt, { ...opts, port: MCP_HTTP_PORT });
    } catch {
      http = await serveMcpHttp(rt, { ...opts, port: 0 });
    }
    await mkdir(dirname(options.mcpTokenFile), { recursive: true });
    await writeFile(options.mcpTokenFile, `${http.token}\n`, { mode: 0o600 });
    // The token never goes into this file, only where to read it.
    // appName: which app this is (Spica, or a company build's own name), for scripts to check.
    const info = { url: http.url, tokenFile: options.mcpTokenFile, pid: process.pid, startedAt: new Date().toISOString(), appName: APP_NAME };
    await writeFile(options.mcpInfoFile, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    return httpState();
  };

  return {
    mcpTools: plugins.mcpTools,
    warnings: plugins.warnings,
    methods: {
      ...plugins.methods,
      plugins: (cmd: unknown) => page.run(cmd as PluginsCommand),
      workflows: () => ({ names: [...rt.workflows.values()].map((w) => w.name), errors: [...rt.workflowErrors] }),
      mcpHttpStart: () => startHttp(),
      mcpHttpStop: async () => {
        await stopHttp();
        return null;
      },
      mcpHttpState: () => httpState(),
      usageLog: async (req: { filter: { projectId?: string; from?: string; to?: string }; file: string }) => {
        const text = rt.exportUsageLog(req.filter ?? {});
        await writeFile(req.file, text ? `${text}\n` : '', 'utf8');
        // The first line is the header (schema, version, filter); the rest are records.
        const lines = text ? text.split('\n').length : 0;
        return { file: req.file, records: Math.max(0, lines - 1) };
      },
    },
    // The app's network settings changed (the core calls this): plugin servers restart to use them.
    networkChanged: () => plugins.networkChanged(),
    close: async () => {
      await stopHttp();
      await plugins.close();
    },
  };
}
