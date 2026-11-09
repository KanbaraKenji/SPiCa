// The agent core's own process (Electron utilityProcess). Same protocol as
// @spica/core's host/utility-entry.ts, but with the file extractors and the
// plugin manager linked in at build time (the packaged app has no
// node_modules to load them from by name), plus the desktop-only methods:
//   setProviders(configs, current)  apply the settings page's models without a restart
//   createSession(req)              new top-level sessions go to the current default model
//   probeProvider(config, model)    「测试连接」
//   plugins(cmd)                    the plugin page
//
// main → backend  { type: 'start', config: DesktopBackendConfig } + ports[0]
// main → backend  { type: 'connect' } + ports[0]      another host connection
// main → backend  { type: 'shutdown' }                close() then exit 0
// backend → main  { type: 'started', restored, warnings } | { type: 'failed', code, message }
// backend → main  { type: 'plugins.changed' }
import { BackendServer, createProvider, electronPort, probeProvider, startBackend, type Backend, type ProviderConfig } from '@spica/core';
import type { CreateSessionRequest } from '@spica/protocol';
import { createExtractors } from '@spica/extract';
import { attachBackend } from '@spica/plugins';
import { RealPluginService } from '../main/plugins/service';
import type { DesktopBackendConfig } from './config';
import type { PluginsCommand } from '../shared/plugins';

interface ParentPort {
  on(ev: 'message', cb: (e: { data: unknown; ports: unknown[] }) => void): void;
  postMessage(v: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  console.error('the backend entry must run inside an Electron utilityProcess');
  process.exit(2);
}

let backend: Backend | undefined;
let server: BackendServer | undefined;
let plugins: RealPluginService | undefined;
let ready: { restored: Backend['restored']; warnings: string[] } | undefined;

async function start(cfg: DesktopBackendConfig): Promise<void> {
  const b = await startBackend({ ...cfg.core, extractorModules: [], extensions: [] });
  backend = b;
  const rt = b.runtime;
  // Linked in at build time rather than loaded by module name.
  rt.extractors.push(...createExtractors());

  let current = cfg.current;
  // The plugins package's own backend hook, linked in rather than loaded by name.
  const attached = await attachBackend(rt, { root: cfg.pluginRoot });
  const manager = attached.manager;
  plugins = new RealPluginService({
    manager,
    root: cfg.pluginRoot,
    sourcesFile: cfg.pluginSourcesFile,
    // Opening folders is the main process's job (it handles 'openRoot' itself).
    openFolder: async () => '',
  });
  plugins.onChange(() => parentPort!.postMessage({ type: 'plugins.changed' }));

  // Our own server (instead of b.server) so the desktop methods sit next to AgentApi.
  b.server.close();
  server = new BackendServer(rt, {
    extraMethods: {
      createSession: (req: unknown) => {
        const r = (req ?? {}) as CreateSessionRequest;
        const api = rt as unknown as { createSession(r: CreateSessionRequest): { info(): unknown } };
        if (r.providerId || r.parentId || !current) return api.createSession(r).info();
        return api.createSession({ ...r, providerId: current.providerId, model: current.model }).info();
      },
      setProviders: (configs: unknown, cur: unknown) => {
        for (const c of (configs as ProviderConfig[]) ?? []) rt.addProvider(createProvider(c), c.limits);
        current = (cur as typeof current) ?? current;
        return true;
      },
      probeProvider: (config: unknown, model: unknown) => probeProvider(createProvider(config as ProviderConfig), { model: String(model), tracer: rt.tracer }),
      plugins: (cmd: unknown) => plugins!.run(cmd as PluginsCommand),
    },
  });
  ready = { restored: b.restored, warnings: [...b.warnings, ...attached.warnings] };
}

parentPort.on('message', (e) => {
  const msg = (e.data ?? {}) as { type?: string; config?: DesktopBackendConfig };
  const port = e.ports[0] as Parameters<typeof electronPort>[0] | undefined;
  if (msg.type === 'start' && msg.config && !backend) {
    start(msg.config).then(
      () => {
        if (port && server && ready) server.attach(electronPort(port), ready);
        parentPort.postMessage({ type: 'started', ...ready });
      },
      (err: Error & { code?: string }) => {
        parentPort.postMessage({ type: 'failed', code: err.code ?? 'start_failed', message: err.message });
        process.exit(1);
      },
    );
  } else if (msg.type === 'connect' && server && port && ready) {
    server.attach(electronPort(port), ready);
  } else if (msg.type === 'shutdown') {
    const done = () => process.exit(0);
    void (async () => {
      server?.close();
      await plugins?.dispose().catch(() => undefined);
      await backend?.close();
    })().then(done, done);
  }
});
