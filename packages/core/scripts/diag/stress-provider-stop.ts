// Spica provider: start a stream, stop it on the first text (user interrupt), then a normal call; repeat.
import { OpenAICompatibleProvider } from '../../src/providers/openai.ts';
import { FakeGateway } from '../../src/testing/fake-gateway.ts';
const external = process.env.GW_URL;
const gw = external ? undefined : await new FakeGateway().start();
gw?.onRequest((r) => (JSON.stringify(r.body).includes('HANG') ? { text: ['a', 'b'], hangAfterChunks: 1 } : { text: 'ok' }));
const base = external ?? gw!.baseUrl;
const p = new OpenAICompatibleProvider({ id: 'x', baseUrl: `${base}/v1`, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } });
const msg = (t: string) => [{ id: 'm', sessionId: 's', seq: 1, role: 'user' as const, kind: 'user' as const, content: [{ type: 'text' as const, text: t }], createdAt: '' }];
const rounds = Number(process.argv[2] ?? 2000);
for (let i = 0; i < rounds; i++) {
  const ac = new AbortController();
  await (async () => { for await (const e of p.stream({ model: 'm', system: '', messages: msg('HANG'), tools: [], maxTokens: 5 }, { signal: ac.signal })) if (e.type === 'text') ac.abort(); })().catch(() => 0);
  for await (const _ of p.stream({ model: 'm', system: '', messages: msg('go'), tools: [], maxTokens: 5 }, { signal: new AbortController().signal })) void _;
  if (i % 500 === 0) console.log('round', i, 'open on server', gw?.inFlight);
}
console.log('survived');
process.exit(0);
