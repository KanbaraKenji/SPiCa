// Real-model check of memory entries (a name, a summary, a category; the
// notes are its details): the user says six things across new conversations,
// three of which belong to one entry; then a new conversation asks something
// only an entry's details answer (does the model call recall?); then one detail
// is forgotten (does the summary lose it too?); then two old
// notes in no entry are tidied into entries; then a detail the summary names
// is deleted in the settings (the entry is marked 待整理) and a second tidy
// rewrites the summary and clears the mark. Prints every remember / recall
// call with the runtime's reply, the entries and details after each step, and
// the cost.
//
//   node --env-file=../../.env.local scripts/entry-memory.ts [model]
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOP_TEMPLATE } from '../src/projects.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai.ts';
import { Runtime } from '../src/runtime.ts';
import { SqliteStore } from '../src/store/sqlite.ts';

const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
const apiKey = process.env.SPICA_OPENAI_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('usage: node --env-file=… scripts/entry-memory.ts [model] (needs SPICA_OPENAI_BASE_URL / SPICA_OPENAI_API_KEY)');
  process.exit(2);
}
const model = process.argv[2] ?? 'deepseek-flash';
const root = await mkdtemp(join(tmpdir(), 'spica-entry-memory-'));
const rt = new Runtime({
  providers: [new OpenAICompatibleProvider({ id: 'openai', baseUrl, apiKey })],
  defaults: { providerId: 'openai', model, maxTokens: 1500, maxTurns: 8 },
  cwd: root,
  projectsRoot: join(root, 'projects'),
  store: new SqliteStore(join(root, 'spica.db')),
  budget: { perRunUsd: 0.3 },
  redactions: [apiKey, baseUrl],
  templates: [{ ...TOP_TEMPLATE, tools: ['search_history', 'read_history', 'remember', 'recall', 'forget'] }],
});

let costUsd = 0;
rt.events.on((e) => {
  if (e.type === 'cost' && e.scope === 'global') costUsd = e.spentUsd;
});

const show = (title: string) => {
  console.log(`\n== ${title}`);
  const items = rt.memory.list();
  for (const e of rt.memory.entries()) {
    console.log(`## ${e.name} (${e.category ?? '-'})${e.stale ? ' [待整理]' : ''}: ${e.summary}`);
    for (const m of items.filter((x) => x.entryId === e.id)) console.log(`  [${m.id}] ${m.text}`);
  }
  const loose = items.filter((m) => m.entryId === undefined || !rt.memory.entry(m.entryId));
  if (loose.length) console.log('(no entry)', loose.map((m) => `[${m.id}] ${m.text}`).join(' / '));
};

async function say(text: string): Promise<string> {
  const s = rt.createSession();
  const calls: string[] = [];
  const off = rt.events.on((e) => {
    if (e.sessionId !== s.id) return;
    if (e.type === 'tool.start') calls.push(`${e.name} ${JSON.stringify(e.input)}`);
    if (e.type === 'tool.end') calls[calls.length - 1] += `\n      -> ${e.isError ? '(refused) ' : ''}${e.preview.replace(/^\[fetched at [^\]]+\]\n/, '').replace(/\n/g, ' | ').slice(0, 300)}`;
  });
  await s.send(text).done;
  off();
  const answer = s
    .messages()
    .filter((m) => m.kind === 'assistant')
    .map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''))
    .join(' ')
    .trim();
  console.log(`\n> ${text}`);
  for (const c of calls) console.log(`    ${c}`);
  console.log(`  ${answer.slice(0, 200).replace(/\n/g, ' ')}`);
  return answer;
}

for (const t of [
  '记住：回答我的时候先给结论，再说细节。',
  '我在工程部，负责样品和报价。',
  '记住：报价单金额一律写含税价。',
  '王经理是我的直属上司，周报都发给他。',
  '报价单发出去之前要抄送王经理。',
  '我平时喜欢研究注塑模具的材料。',
]) {
  await say(t);
}
show('after six things');

await say('我要发一份报价单给客户，金额怎么写、发之前要做什么？');

// forgetting a detail the summary names: the summary should lose it too
await say('报价单抄送王经理那条不用了，别记了。');
show('after forgetting one');

// two notes saved before there were entries
rt.memory.addOwn('一般周三下午不开会');
rt.memory.addOwn('出差报销找李老师审批');
show('two notes in no entry');
const tidy = () => {
  rt.memory.tidy('user');
  return new Promise<void>((resolve) => {
    const off = rt.events.on((e) => {
      if (e.type === 'memory.tidy' && e.run.status !== 'running') {
        off();
        const r = e.run;
        console.log(`\ntidy: ${r.status} changes ${r.changes.length} refused ${r.refused} grouped ${JSON.stringify(r.grouped ?? [])} entries ${JSON.stringify(r.entries ?? [])} ${r.error ?? ''}`);
        resolve();
      }
    });
  });
};
await tidy();
show('after the tidy');

// settings: an entry with two details its summary names, then 删除 on one of them: marked 待整理, a tidy
// (nothing new to read) makes the summary again from the detail left
const made = rt.memory.addOwn('样品寄出前拍照', { name: '样品', summary: '寄出前拍照，单号写进周报', category: 'areas' });
const sample = 'item' in made ? made : undefined;
if (sample?.item && sample.entry) {
  rt.memory.addOwn('样品单号写进周报', sample.entry.id);
  show('an entry made in the settings');
  rt.memory.delete(sample.item.id);
  show(`deleted [${sample.item.id}] 样品寄出前拍照 in the settings`);
  console.log(`\nsystem prompt block:\n${rt.memory.promptBlock()}`);
  await tidy();
  show('after the second tidy');
}
console.log(`\nsystem prompt block:\n${rt.memory.promptBlock()}`);
console.log(`\ncost: $${costUsd.toFixed(4)}`);
await rt.close();
await rm(root, { recursive: true, force: true });
