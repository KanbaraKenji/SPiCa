// Electron check of the backend process (run: electron scripts/electron/host-check.ts).
// Forks utility-entry.ts as a real utilityProcess, talks to it over a
// MessageChannelMain, kills it, restarts it, and checks that restore() brought
// the session back. Uses the fake gateway, no real model.
import { app, MessageChannelMain, utilityProcess } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectBackend } from '../../src/host/client.ts';
import { electronPort } from '../../src/host/wire.ts';
import { FakeGateway } from '../../src/testing/fake-gateway.ts';

const entry = fileURLToPath(new URL('../../src/host/utility-entry.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'spica-host-'));
const results: string[] = [];
const check = (name: string, ok: boolean) => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}`);

async function startChild(config: unknown) {
  const child = utilityProcess.fork(entry, [], { serviceName: 'spica-backend', stdio: 'pipe' });
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[backend] ${d}`));
  const { port1, port2 } = new MessageChannelMain();
  const client = connectBackend(electronPort(port1));
  const started = new Promise<{ type: string; restored?: { sessions: number; interrupted: string[] }; message?: string }>((r) =>
    child.on('message', (m: { type: string }) => r(m)),
  );
  child.postMessage({ type: 'start', config }, [port2]);
  return { child, client, started: await started };
}

app.whenReady().then(async () => {
  const gw = await new FakeGateway().start();
  gw.onRequest(() => ({ text: 'answer from the fake model' }));
  const config = {
    dbPath: join(dir, 'spica.db'),
    providers: [{ id: 'gw', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1` }],
    defaults: { providerId: 'gw', model: 'm', maxTokens: 64 },
    cwd: dir,
  };
  try {
    const a = await startChild(config);
    check('backend started in a utilityProcess', a.started.type === 'started');
    const s = await a.client.api.createSession({});
    await a.client.api.send(s.id, 'hello');
    const done = await new Promise<boolean>((r) => {
      const off = a.client.onEvent((e) => {
        if (e.type === 'run.end') {
          off();
          r(true);
        }
      });
      setTimeout(() => r(false), 10_000);
    });
    check('a run completed over the port', done);
    const exited = new Promise((r) => a.child.once('exit', r));
    a.child.kill(); // simulate a crash
    await exited;
    a.client.fail('backend exited');
    const b = await startChild(config);
    check('restarted backend restored the session', (b.started.restored?.sessions ?? 0) >= 1);
    const msgs = await b.client.api.getMessages(s.id);
    check('history survived the crash', msgs.map((m) => m.kind).join(',') === 'user,assistant');
    b.child.postMessage({ type: 'shutdown' });
    await new Promise((r) => b.child.once('exit', r));
    check('shutdown exits cleanly', true);
  } catch (err) {
    results.push(`FAIL exception: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await gw.stop();
    console.log(results.join('\n'));
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // the database may still be closing on Windows
    }
    const code = results.every((r) => r.startsWith('PASS')) ? 0 : 1;
    app.exit(code);
    process.exit(code);
  }
});
