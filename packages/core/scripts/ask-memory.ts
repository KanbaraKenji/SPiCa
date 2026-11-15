// Real-model check of a sentence typed on a memory page (askMemory): five entries, one sentence on each page —
// a new summary, a detail deleted, a detail moved to an entry there is, one moved to a new entry, and one the
// model cannot act on. Prints each run (its changes, what was put where, the model's words) and the memory after.
//
//   node --env-file=../../.env.local scripts/ask-memory.ts [model] [db]
//
// db: where to keep the store (default: a new temporary folder); the desktop app opened on the same folder
// (SPICA_USER_DATA=<folder>, spica.db in it) shows the runs on the pages.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { MemoryTidyRun } from '@spica/protocol';
import { OpenAICompatibleProvider } from '../src/providers/openai.ts';
import { Runtime } from '../src/runtime.ts';
import { SqliteStore } from '../src/store/sqlite.ts';

const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
const apiKey = process.env.SPICA_OPENAI_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('usage: node --env-file=… scripts/ask-memory.ts [model] [db] (needs SPICA_OPENAI_BASE_URL / SPICA_OPENAI_API_KEY)');
  process.exit(2);
}
const model = process.argv[2] ?? 'deepseek-flash';
const db = process.argv[3] ?? join(await mkdtemp(join(tmpdir(), 'spica-ask-memory-')), 'spica.db');
mkdirSync(dirname(db), { recursive: true });
const root = dirname(db);
const rt = new Runtime({
  providers: [new OpenAICompatibleProvider({ id: 'openai', baseUrl, apiKey })],
  defaults: { providerId: 'openai', model, maxTokens: 1500, maxTurns: 8 },
  cwd: root,
  projectsRoot: join(root, 'projects'),
  store: new SqliteStore(db),
  budget: { perRunUsd: 0.3 },
  redactions: [apiKey, baseUrl],
});

let costUsd = 0;
rt.events.on((e) => {
  if (e.type === 'cost' && e.scope === 'global') costUsd = e.spentUsd;
});

const entry = (name: string, summary: string, category: 'you' | 'people' | 'areas' | 'projects', details: string[]) => {
  const first = rt.memory.addOwn(details[0]!, { name, summary, category }) as { entry: { id: number } };
  for (const d of details.slice(1)) rt.memory.addOwn(d, first.entry.id);
  return first.entry.id;
};

const show = (title: string) => {
  console.log(`\n== ${title}`);
  const items = rt.memory.list();
  for (const e of rt.memory.entries()) {
    console.log(`## ${e.name} (${e.category ?? '-'})${e.stale ? ' [待整理]' : ''}: ${e.summary}`);
    for (const m of items.filter((x) => x.entryId === e.id)) console.log(`  [${m.id}] ${m.text}`);
  }
};

const done = () =>
  new Promise<MemoryTidyRun>((resolve) => {
    const off = rt.events.on((e) => {
      if (e.type === 'memory.tidy' && e.run.by === 'ask' && e.run.status !== 'running') {
        off();
        resolve(e.run);
      }
    });
  });

const report = entry('周报', '每周五发', 'areas', ['周报每周五下午发']);
const boss = entry('王经理', '直属上司，报价单抄送他，出差报销找他审批', 'people', ['王经理是直属上司', '报价单抄送王经理', '出差报销找王经理审批']);
const eng = entry('工程部', '负责样品和报价；周报发给王经理', 'areas', ['工程部负责样品和报价', '周报发给王经理']);
const sample = entry('外壳样机', '月底前交第二版；每周三下午开样机例会', 'projects', ['外壳样机月底前交第二版', '每周三下午和供应商开样机例会']);
const client = entry('客户', '写给客户的邮件开头不用客套话', 'areas', ['写给客户的邮件开头不用客套话']);
show('before');

const asks: [string, number, string][] = [
  ['moved to an entry there is', eng, '周报发给王经理那条移到周报'],
  ['a new summary', report, '摘要改成：每周五下午五点前发给王经理'],
  ['a detail deleted', boss, '出差报销那条不要了'],
  ['moved to a new entry', sample, '每周三开例会那条单独放一个条目，叫样机例会'],
  ['a sentence it cannot act on', client, '今天天气怎么样'],
];
for (const [what, id, text] of asks) {
  const end = done();
  const r = rt.memory.ask({ entry: id }, text);
  if (!r.started) {
    console.log(`\n-- ${what}: not started (${r.reason})`);
    continue;
  }
  const run = await end;
  console.log(`\n-- ${what}: 「${text}」 -> ${run.status}${run.error ? ` (${run.error})` : ''}`);
  for (const c of run.changes) console.log(`   ${c.action}: ${c.item.text}${c.previous?.length ? ` (was ${c.previous.map((p) => p.text).join(' / ')})` : ''}`);
  for (const g of run.grouped ?? []) console.log(`   moved [${g.item}] -> entry ${g.entry}${g.from !== undefined ? ` (from ${g.from})` : ''}`);
  for (const t of run.entries ?? []) console.log(`   entry ${t.entry}: ${t.before ? `was ${JSON.stringify({ name: t.before.name, summary: t.before.summary, category: t.before.category })}` : 'new'}`);
  console.log(`   refused ${run.refused}; reply: ${run.ask?.reply ?? '-'}`);
}
show('after');
console.log(`\ncost US$${costUsd.toFixed(4)}`);
await rt.close?.();
