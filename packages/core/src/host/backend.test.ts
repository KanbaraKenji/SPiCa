// Backend startup from a JSON config: lock, restore, probe over the wire.
import { MessageChannel } from 'node:worker_threads';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { startGateway, tempDir } from '../testing/helpers.ts';
import { createProvider, lockDatabase, startBackend, type BackendConfig } from './backend.ts';
import { connectBackend } from './client.ts';
import { nodePort } from './wire.ts';

// gateways, child processes and local servers start slowly when several full runs share the machine
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  gw = await startGateway({ apiKey: 'test-key-123456' });
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await gw.stop();
  await cleanup();
});

const config = (): BackendConfig => ({
  dbPath: join(dir, 'data', 'spica.db'),
  providers: [{ id: 'gw', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1`, apiKey: 'test-key-123456', limits: { maxConcurrent: 2 } }],
  defaults: { providerId: 'gw', model: 'm', maxTokens: 64 },
  cwd: dir,
  extractorModules: ['spica-no-such-extractor-module'],
});

describe('startBackend', () => {
  it('starts from a config, serves over a port, and restores after a restart', async () => {
    gw.onRequest(() => ({ text: 'hello' }));
    const b1 = await startBackend(config());
    expect(b1.warnings.join('\n')).toMatch(/spica-no-such-extractor-module could not be loaded/);
    const ch = new MessageChannel();
    b1.server.attach(nodePort(ch.port1), { restored: b1.restored, warnings: b1.warnings });
    const client = connectBackend(nodePort(ch.port2));
    await client.ready;
    const s = await client.api.createSession({});
    await client.api.send(s.id, 'hi');
    await b1.runtime.session(s.id)!.idle();
    ch.port1.close();
    ch.port2.close();
    await b1.close();

    const b2 = await startBackend(config());
    expect(b2.restored.sessions).toBe(1);
    expect(b2.runtime.session(s.id)!.messages().map((m) => m.kind)).toEqual(['user', 'assistant']);
    await b2.close();
  });

  it('regenerate and getMessages with the old versions work over the port', async () => {
    gw.enqueue({ text: 'first' }, { text: 'second' });
    const b = await startBackend(config());
    const ch = new MessageChannel();
    b.server.attach(nodePort(ch.port1), { restored: b.restored, warnings: b.warnings });
    const client = connectBackend(nodePort(ch.port2));
    await client.ready;
    const s = await client.api.createSession({});
    await client.api.send(s.id, 'q');
    await b.runtime.session(s.id)!.idle();
    expect(await client.api.regenerate!(s.id)).toMatchObject({ ok: true, version: 2 });
    await b.runtime.session(s.id)!.idle();
    const text = (m: { content: { type: string; text?: string }[] }) => m.content.map((x) => x.text ?? '').join('');
    expect((await client.api.getMessages(s.id)).map(text)).toEqual(['q', 'second']);
    expect((await client.api.getMessages(s.id, { superseded: true })).map(text)).toEqual(['q', 'first', 'second']);
    ch.port1.close();
    ch.port2.close();
    await b.close();
  });

  it('a second process cannot open the same database; a stale lock is taken over', async () => {
    const path = join(dir, 'x.db');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(`${path}.lock`, '1'); // pid 1 is never ours; on Windows it is not a live user process
    const pidAlive = (() => {
      try {
        process.kill(1, 0);
        return true;
      } catch {
        return false;
      }
    })();
    if (pidAlive) {
      expect(() => lockDatabase(path)).toThrow(/in use by process 1/);
    } else {
      const release = lockDatabase(path); // stale: taken over
      release();
    }
    const b = await startBackend(config());
    await expect(startBackend(config())).rejects.toThrow(/already open in this process/);
    await b.close();
    await (await startBackend(config())).close(); // released on close
  });

  it('probeProvider works over the wire with a provider config from the form', async () => {
    gw.enqueue({ text: 'pong' });
    const b = await startBackend(config());
    const ch = new MessageChannel();
    b.server.attach(nodePort(ch.port1));
    const client = connectBackend(nodePort(ch.port2));
    const ok = await client.call('probeProvider', { id: 'form', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1`, apiKey: 'test-key-123456' }, 'm');
    expect(ok).toMatchObject({ ok: true });
    const bad = await client.call('probeProvider', { id: 'form', kind: 'openai-compatible', baseUrl: `${gw.baseUrl}/v1`, apiKey: 'nope-nope-nope' }, 'm');
    expect(bad).toMatchObject({ ok: false, errorCode: 'auth' });
    ch.port1.close();
    ch.port2.close();
    await b.close();
  });

  it('modules linked in by the host are used instead of importing by package name', async () => {
    const calls: string[] = [];
    const b = await startBackend(
      { ...config(), extractorModules: ['@acme/not-installed-extract'], extensions: [{ module: '@acme/not-installed-plugins', options: { k: 1 } }] },
      {
        modules: {
          '@acme/not-installed-extract': { createExtractors: () => [{ extensions: ['.zz'], extract: async () => 'zz' }] },
          '@acme/not-installed-plugins': {
            attachBackend: (_rt: unknown, opts: unknown) => {
              calls.push(JSON.stringify(opts));
              return { mcpTools: [{ name: 'spica_acme', description: '', inputSchema: {}, run: async () => 1 }] };
            },
          },
        },
      },
    );
    try {
      expect(b.warnings.join(' | ')).not.toMatch(/could not be/);
      expect(b.runtime.extractors.map((e) => e.extensions)).toEqual([['.zz']]);
      expect(calls).toEqual(['{"k":1}']);
      expect(b.mcpTools.map((t) => t.name)).toEqual(['spica_acme']);
    } finally {
      await b.close();
    }
  });

  it('createProvider builds each kind and rejects incomplete configs', () => {
    expect(createProvider({ id: 'a', kind: 'anthropic', apiKey: 'k' }).kind).toBe('anthropic');
    expect(createProvider({ id: 'w', kind: 'wso2', baseUrl: 'http://x/v1', oauth: { tokenUrl: 'http://x/t', clientId: 'c', clientSecret: 's' } }).kind).toBe('wso2');
    expect(() => createProvider({ id: 'o', kind: 'openai-compatible' })).toThrow(/baseUrl is required/);
  });
});
