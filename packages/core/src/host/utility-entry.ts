// Entry of the backend process inside Electron (utilityProcess.fork(file)).
//
// Use this file directly (development: modules are imported by name), or, in a
// packaged app, a two-line entry of your own that links the modules in:
//
//   import * as extract from '@spica/extract';
//   import * as plugins from '@spica/plugins';
//   import { runUtilityEntry } from '@spica/core/src/host/utility-entry.ts';
//   runUtilityEntry({ modules: { '@spica/extract': extract, '@spica/plugins': plugins } });
//
// Protocol with the main process (process.parentPort):
//   main → backend  { type: 'start', config: BackendConfig } + ports[0] = MessagePort for the AgentApi wire
//   main → backend  { type: 'connect' } + ports[0] = another MessagePort (e.g. after a window reload)
//   main → backend  { type: 'shutdown' }          → runs close() (runs become interrupted), then exits 0
//   backend → main  { type: 'started', restored, warnings } | { type: 'failed', code, message }
// The main process restarts the backend if it exits unexpectedly; restore()
// then brings sessions back (see docs/design/agent-core.md, 12b).
import { startBackend, type Backend, type BackendConfig, type BackendHost } from './backend.ts';
import { electronPort } from './wire.ts';

interface ParentPort {
  on(ev: 'message', cb: (e: { data: unknown; ports: unknown[] }) => void): void;
  postMessage(v: unknown): void;
}

export function runUtilityEntry(host: BackendHost = {}): void {
  const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
  if (!parentPort) {
    console.error('the Spica backend entry must run inside an Electron utilityProcess');
    process.exit(2);
  }
  let backend: Backend | undefined;
  parentPort.on('message', (e) => {
    const msg = (e.data ?? {}) as { type?: string; config?: BackendConfig };
    const port = e.ports[0] as Parameters<typeof electronPort>[0] | undefined;
    if (msg.type === 'start' && msg.config && !backend) {
      startBackend(msg.config, host).then(
        (b) => {
          backend = b;
          const ready = { restored: b.restored, warnings: b.warnings };
          if (port) b.server.attach(electronPort(port), ready);
          parentPort.postMessage({ type: 'started', ...ready });
        },
        (err: Error & { code?: string }) => {
          parentPort.postMessage({ type: 'failed', code: err.code ?? 'start_failed', message: err.message });
          process.exit(1);
        },
      );
    } else if (msg.type === 'connect' && backend && port) {
      backend.server.attach(electronPort(port), { restored: backend.restored, warnings: backend.warnings });
    } else if (msg.type === 'shutdown') {
      const done = () => process.exit(0);
      (backend ? backend.close() : Promise.resolve()).then(done, done);
    }
  });
}

// Run when this file itself is the utilityProcess entry (not when imported).
if ((import.meta as ImportMeta & { main?: boolean }).main) runUtilityEntry();
