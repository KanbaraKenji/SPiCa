// Helper process for the hard-kill recovery test (run with plain `node`).
// argv: <dbPath> <gatewayBaseUrl> <cwd>
// Starts a run whose tool never returns, queues a steer, prints READY, then
// waits to be killed.
import { OpenAICompatibleProvider } from '../providers/openai.ts';
import { Runtime } from '../runtime.ts';
import { SqliteStore } from '../store/sqlite.ts';

const [dbPath, baseUrl, cwd] = process.argv.slice(2) as [string, string, string];
const rt = new Runtime({
  providers: [new OpenAICompatibleProvider({ id: 'fake-openai', baseUrl: `${baseUrl}/v1`, apiKey: 'test-key-123456' })],
  defaults: { providerId: 'fake-openai', model: 'fake-model', maxTokens: 256 },
  store: new SqliteStore(dbPath),
  cwd,
  tools: [
    {
      spec: { name: 'hang', description: 'never returns', inputSchema: { type: 'object' } },
      execute: () => {
        const s = rt.sessions()[0]!;
        s.steer('message typed before the crash', 'next');
        process.stdout.write('READY\n');
        return new Promise(() => {});
      },
    },
  ],
});
const s = rt.createSession({ title: 'crash victim' });
s.send('start the long job');
setInterval(() => {}, 1000); // stay alive until killed
