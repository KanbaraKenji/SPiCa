// A real tidy of the memory: two conversations are made through a local fake
// gateway (it answers 好的 and never calls the memory tools), notes are saved as
// if the assistant had saved them in the first one, the user changes their
// mind and mentions new things in the second; then the default model
// (deepseek-flash) tidies. Prints the notes before and after, every change and
// the cost. With <db-dir>, the database is written there (spica.db), once
// before (before/) and once after the tidy (after/), to open in the app.
//
//   node --env-file=../../.env.local scripts/tidy-memory.ts [db-dir] [model]
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_CATALOG } from '../src/catalog/builtin.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai.ts';
import { Runtime } from '../src/runtime.ts';
import { SqliteStore } from '../src/store/sqlite.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { openaiProvider, startGateway } from '../src/testing/helpers.ts';
import type { MemoryTidyRun } from '../src/types.ts';

const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
const apiKey = process.env.SPICA_OPENAI_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('usage: node --env-file=… scripts/tidy-memory.ts [db-dir] [model]');
  process.exit(2);
}
const dbDir = process.argv[2];
const model = process.argv[3] ?? 'deepseek-flash';
const gw = await startGateway();
gw.onRequest(() => ({ text: '好的。' }));
const dbPath = dbDir ? join(dbDir, 'after', 'spica.db') : undefined;
if (dbDir) mkdirSync(join(dbDir, 'after'), { recursive: true });
const rt = new Runtime({
  providers: [new OpenAICompatibleProvider({ id: 'deepseek', baseUrl, apiKey }), openaiProvider(gw, 'local')],
  defaults: { providerId: 'deepseek', model, maxTokens: 800 },
  cwd: process.cwd(),
  store: dbPath ? new SqliteStore(dbPath) : new MemoryStore(),
  redactions: [apiKey, baseUrl, 'test-key-123456'],
});
const pause = () => new Promise((r) => setTimeout(r, 20));
const talk = async (title: string, lines: string[]) => {
  const s = rt.createSession({ providerId: 'local', model: 'local', title });
  for (const l of lines) await s.send(l).done;
  return s;
};
const seqOf = (s: Awaited<ReturnType<typeof talk>>, words: string) => s.messages().find((m) => m.kind === 'user' && JSON.stringify(m.content).includes(words))!.seq;

const first = await talk('数据处理和周报', ['我数据处理主要用 Python。', '我喜欢简短的回答。', '回答别太长，三五句话就行。', '周报每周五下午发给王经理。']);
const saved: [string, string, string][] = [
  ['数据处理主要用 Python', '我数据处理主要用 Python', 'Python'],
  ['喜欢简短的回答', '我喜欢简短的回答', '简短'],
  ['回答别太长，三五句话就行', '回答别太长，三五句话就行', '三五句'],
  ['周报每周五下午发给王经理', '周报每周五下午发给王经理', '周报'],
];
for (const [text, quote, w] of saved) rt.memory.add({ text, quote, sessionId: first.id, seq: seqOf(first, w), by: 'assistant' });
await pause();
await talk('改用 Julia', ['跟你说一下，我现在数据处理改用 Julia 了，Python 基本不用。', '帮我算一下 23 乘 17。']);
await talk('周报和表格', ['周报改成每周一上午发了。', '我负责公司的开单系统。', '给我的表格都做窄一点，我多半用手机看。', '今天好冷。']);
if (dbDir) {
  mkdirSync(join(dbDir, 'before'), { recursive: true });
  // a copy of the database as it is now (with its write-ahead log)
  for (const ext of ['', '-wal', '-shm']) if (existsSync(dbPath! + ext)) copyFileSync(dbPath! + ext, join(dbDir, 'before', `spica.db${ext}`));
}
const notes = () => rt.memory.list().map((m) => `[${m.id}] ${m.text}`);
console.log('before:\n' + notes().join('\n'));
const done = new Promise<MemoryTidyRun>((resolve) => rt.events.on((e) => e.type === 'memory.tidy' && e.run.status !== 'running' && resolve(e.run)));
console.log(JSON.stringify(rt.memory.tidy('user')));
const run = await done;
console.log(`\ntidy: ${run.status}${run.error ? ` (${run.error})` : ''} · ${run.sessions} conversations, ${run.messages} messages · ${run.changes.length} changes, ${run.refused} refused`);
for (const c of run.changes) console.log(`  ${c.action}: ${c.item.text}${c.previous?.length ? `  ← ${c.previous.map((p) => p.text).join(' | ')}` : ''}`);
console.log('\nafter:\n' + notes().join('\n'));
const price = BUILTIN_CATALOG.providers.flatMap((p) => p.models).find((m) => m.id === model)?.price;
const t = rt.store.listTraces().find((x) => x.initiator === 'runtime:memory-tidy');
console.log(`\ncost: ${run.costUsd?.toFixed(5)} USD · tokens in ${t?.inputTokens} out ${t?.outputTokens}${price ? ` · about ${(((t?.inputTokens ?? 0) * price.input + (t?.outputTokens ?? 0) * price.output) / 1e6).toFixed(4)} ${price.currency}` : ''}`);
await rt.close();
await gw.stop();
