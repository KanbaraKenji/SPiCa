// Real-model check for the history tools: earlier conversations are put into the
// store, then the assistant is asked about them. The check: the answers name
// conversations by title and time, and never repeat a conversation id or a
// result number ([n]); numbers are only used in tool calls. Prints the tokens
// and the cost (catalog prices).
//
//   node --env-file=../../.env.local scripts/smoke-history.ts [rounds]
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_CATALOG } from '../src/catalog/builtin.ts';
import { TOP_TEMPLATE } from '../src/projects.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai.ts';
import { Runtime } from '../src/runtime.ts';
import { SqliteStore } from '../src/store/sqlite.ts';
import type { Message } from '../src/types.ts';

const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
const apiKey = process.env.SPICA_OPENAI_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('missing SPICA_OPENAI_BASE_URL / SPICA_OPENAI_API_KEY');
  process.exit(2);
}
const model = process.env.SPICA_OPENAI_MODEL ?? 'deepseek-flash';
const rounds = Number(process.argv[2] ?? 2);

const root = await mkdtemp(join(tmpdir(), 'spica-history-'));
const dbPath = join(root, 'spica.db');
const make = () =>
  new Runtime({
    providers: [new OpenAICompatibleProvider({ id: 'openai', baseUrl, apiKey })],
    defaults: { providerId: 'openai', model, maxTokens: 1500, maxTurns: 8 },
    cwd: root,
    projectsRoot: root,
    store: new SqliteStore(dbPath),
    budget: { perRunUsd: 0.5 },
    templates: [{ ...TOP_TEMPLATE, tools: ['search_history', 'read_history', 'find_history_files'] }],
  });

// earlier conversations, written straight into the store
const seed = make();
const day = (d: number, h: number) => `2026-11-0${d}T${String(h).padStart(2, '0')}:00:00.000+08:00`;
const convs: { title: string | null; at: (i: number) => string; lines: [string, string][]; attach?: string }[] = [
  {
    title: '外壳供应商比较',
    at: (i) => day(3, 10 + i),
    lines: [
      ['user', '帮我比较一下两家外壳供应商：甲公司单价 12.4 欧，交期 6 周；乙公司 11.1 欧，交期 10 周，要预付一半。'],
      ['assistant', '甲公司贵 1.3 欧，但交期短 4 周、不用预付。如果样机赶时间，建议选甲公司。'],
      ['user', '那就先按甲公司走，报价单我附上了。'],
      ['assistant', '好，已记下：外壳先按甲公司，报价单 quote-jia.pdf 已收到。'],
    ],
    attach: 'D:/采购/quote-jia.pdf',
  },
  {
    title: null,
    at: (i) => day(5, 15 + i),
    lines: [
      ['user', '下周的年度预算会，帮我列一下要准备的材料'],
      ['assistant', '要准备：今年各项目实际花费、明年的样机和模具预算、外壳供应商的报价对比。'],
    ],
  },
  {
    title: '模具开模排期',
    at: (i) => day(7, 9 + i),
    lines: [
      ['user', '模具厂说开模要 35 天，外壳要等模具，能赶上 12 月的样机评审吗？'],
      ['assistant', '按 35 天开模，再加试模和甲公司 6 周交期，赶不上 12 月中的评审，建议先做 3D 打印的外壳样件。'],
    ],
  },
];
const ids: string[] = [];
for (const c of convs) {
  const s = seed.createSession();
  if (c.title) s.rename(c.title);
  ids.push(s.id);
  c.lines.forEach(([role, text], i) => {
    const m: Message = {
      id: `msg_seed_${s.id}_${i + 1}`,
      sessionId: s.id,
      seq: i + 1,
      role: role === 'user' ? 'user' : 'assistant',
      kind: role === 'user' ? 'user' : 'assistant',
      content: [{ type: 'text', text }],
      createdAt: c.at(i),
      meta: { author: role === 'user' ? 'user' : 'model', ...(c.attach && i === 2 ? { attachments: [{ path: c.attach, name: 'quote-jia.pdf', block: null }] } : {}) },
    };
    seed.store.appendMessage(m);
  });
}
await seed.close();

const questions = [
  '之前聊外壳供应商的时候最后选了哪家？是哪次聊的？',
  '那次附的报价单文件叫什么，在哪？',
  '有没有聊过模具和样机评审赶不赶得上？结论是什么？',
];

const price = BUILTIN_CATALOG.providers.flatMap((p) => p.models).find((m) => m.id === model)?.price;
let input = 0;
let output = 0;
let cacheRead = 0;
let calls = 0;
const failures: string[] = [];
const answers: string[] = [];
for (let r = 1; r <= rounds; r++) {
  const rt = make();
  rt.restore();
  rt.events.on((e) => {
    if (e.type !== 'usage') return;
    calls++;
    input += e.usage.inputTokens;
    output += e.usage.outputTokens;
    cacheRead += e.usage.cacheReadTokens ?? 0;
  });
  const used: string[] = [];
  rt.events.on((e) => {
    if (e.type === 'tool.start') used.push(`${e.name} ${JSON.stringify(e.input)}`);
  });
  const chat = rt.createSession();
  for (const q of questions) {
    used.length = 0;
    const res = await chat.send(q).done;
    const text = chat
      .messages()
      .filter((m) => m.kind === 'assistant')
      .at(-1)!
      .content.map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    answers.push(`round ${r} · ${q}\n  tools: ${used.join(' | ') || '-'}\n  answer: ${text.replace(/\s+/g, ' ')}`);
    if (res.reason !== 'completed') failures.push(`round ${r} "${q}": run ended ${res.reason}`);
    if (/ses_[0-9a-f]/.test(text)) failures.push(`round ${r} "${q}": the answer has a conversation id`);
    if (/\[\d+\]/.test(text)) failures.push(`round ${r} "${q}": the answer has a result number`);
    if (used.length === 0) failures.push(`round ${r} "${q}": no history tool was used`);
  }
  await rt.close();
}

console.log(answers.join('\n\n'));
const cny = price ? (input - cacheRead) * (price.input / 1e6) + cacheRead * ((price.cacheRead ?? price.input) / 1e6) + output * (price.output / 1e6) : NaN;
console.log(
  `\nmodel ${model} · ${rounds} rounds × ${questions.length} questions · ${calls} model calls · input ${input} (cache read ${cacheRead}) · output ${output} tokens · ` +
    `about ${cny.toFixed(4)} ${price?.currency ?? '?'}`,
);
await rm(root, { recursive: true, force: true });
if (failures.length) {
  console.log(`FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('PASS');
