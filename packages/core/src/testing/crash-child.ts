// Helper process for the hard-kill recovery test (run with plain `node`).
// argv: <dbPath> <gatewayBaseUrl> <cwd> [tool|stream]
// tool: starts a run whose tool never returns, queues a steer, prints READY.
// stream: prints READY once the model has streamed some text (the stream then stalls).
// Then waits to be killed.
import { OpenAICompatibleProvider } from '../providers/openai.ts';
import { Runtime } from '../runtime.ts';
import { SqliteStore } from '../store/sqlite.ts';
import { TEST_PRICES } from './helpers.ts';

const [dbPath, baseUrl, cwd, mode = 'tool'] = process.argv.slice(2) as [string, string, string, string?];
const rt = new Runtime({
  providers: [new OpenAICompatibleProvider({ id: 'fake-openai', baseUrl: `${baseUrl}/v1`, apiKey: 'test-key-123456' })],
  defaults: { providerId: 'fake-openai', model: 'fake-model', maxTokens: 256 },
  prices: TEST_PRICES, // a price, so the restored totals are a number (helpers.ts)
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
if (mode === 'stream') {
  rt.events.on((e) => {
    if (e.type === 'text.delta') setTimeout(() => process.stdout.write('READY\n'), 300);
  });
}
const s = rt.createSession({ title: 'crash victim' });
s.send('start the long job');
setInterval(() => {}, 1000); // stay alive until killed
