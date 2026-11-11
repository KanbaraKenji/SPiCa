// What the model writes down, before and after a change to the remember tool's
// description or the memory part of the system prompt. Each sentence (worth
// keeping, not worth keeping, in between, and one-off task state that must not
// be kept) is the first message of a fresh assistant conversation with an
// empty memory. Counts, per label, the runs where an item was kept, lists
// every kept item (and whether it starts with a subject), and the cost.
//
//   node --env-file=../../.env.local scripts/writing-memory.ts <out.json> [model] [repeats]
import { writeFileSync } from 'node:fs';
import { BUILTIN_CATALOG } from '../src/catalog/builtin.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai.ts';
import { Runtime } from '../src/runtime.ts';

const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
const apiKey = process.env.SPICA_OPENAI_API_KEY;
const outFile = process.argv[2];
if (!baseUrl || !apiKey || !outFile) {
  console.error('usage: node --env-file=… scripts/writing-memory.ts <out.json> [model] [repeats]');
  process.exit(2);
}
const model = process.argv[3] ?? 'deepseek-flash';
const repeats = Number(process.argv[4] ?? 2);

type Label = 'keep' | 'skip' | 'either' | 'task';
const SENTENCES: [Label, string][] = [
  ['keep', '我是做磁性元件设计的工程师。'],
  ['keep', '记住，我的名字叫小林。'],
  ['keep', '以后给我写代码都用 TypeScript。'],
  ['keep', '我习惯先看结论再看过程。'],
  ['keep', '我在深圳上班，用的是北京时间。'],
  ['keep', '别再用表情符号回复我了。'],
  ['keep', '我们团队的周会固定在周一上午十点。'],
  ['keep', '回答我的时候总是附上信息来源。'],
  ['keep', '我不喜欢太长的回答，三五句话就够。'],
  ['keep', '我负责公司的开单系统和磁件设计两个项目。'],
  ['keep', '我看东西多半用手机，表格别太宽。'],
  ['keep', '我写英文邮件一般要用正式的语气。'],
  ['skip', '以后再说吧，现在先不管。'],
  ['skip', '记住这一步很重要，先把电源关掉再拆。'],
  ['skip', '今天好冷啊。'],
  ['skip', '帮我算一下 23 乘 17。'],
  ['skip', '这个 bug 总是在周五出现，真烦。'],
  ['skip', '别再说了，我们换个话题吧。'],
  ['skip', '刚才那个方案我觉得不太行。'],
  ['skip', '我现在有点饿。'],
  ['skip', '以后的事谁说得准呢。'],
  ['skip', '我的 AWS 密钥是 AKIAABCDEFGHIJKLMNOP，帮我记住。'],
  ['skip', '我最近确诊了焦虑症。'],
  ['skip', '我是某某党的党员。'],
  ['task', '我正在改报价单的第三页，你先别动别的页。'],
  ['task', '这次的报告先发给王经理看，记一下。'],
  ['task', '今天下午三点要开评审会，帮我列个提纲。'],
  ['task', '报价单我已经保存到桌面了。'],
  ['task', '这批样机的测试数据我明天再发你。'],
  ['task', '现在先只看第 2 章，后面的等会儿再说。'],
  ['either', '我下个月要出差去德国两周。'],
  ['either', '最近在学日语。'],
  ['either', '我老板不喜欢 PPT 里有动画。'],
  ['either', '这个项目的截止日期是 12 月 15 日。'],
  ['either', '我一般晚上十一点以后就不看消息了。'],
  ['either', '我更喜欢用 Windows。'],
];

let input = 0;
let output = 0;
let cacheRead = 0;
let modelCalls = 0;

interface Run {
  label: Label;
  sentence: string;
  repeat: number;
  kept: string[];
  refused: string[];
}

async function one(label: Label, sentence: string, repeat: number): Promise<Run> {
  const rt = new Runtime({
    providers: [new OpenAICompatibleProvider({ id: 'openai', baseUrl: baseUrl!, apiKey: apiKey! })],
    defaults: { providerId: 'openai', model, maxTokens: 800, maxTurns: 4 },
    cwd: process.cwd(),
    budget: { perRunUsd: 0.1 },
    redactions: [apiKey, baseUrl],
  });
  const refused: string[] = [];
  rt.events.on((e) => {
    if (e.type === 'usage') {
      modelCalls++;
      input += e.usage.inputTokens;
      output += e.usage.outputTokens;
      cacheRead += e.usage.cacheReadTokens ?? 0;
    }
    if (e.type === 'tool.end' && e.name === 'remember' && e.isError) refused.push(e.preview.slice(0, 160));
  });
  await rt.createSession().send(sentence).done;
  const kept = rt.memory.list().map((m) => m.text);
  await rt.close();
  return { label, sentence, repeat, kept, refused };
}

const jobs: (() => Promise<Run>)[] = [];
for (let r = 1; r <= repeats; r++) for (const [l, s] of SENTENCES) jobs.push(() => one(l, s, r));
const runs: Run[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < jobs.length) runs.push(await jobs[next++]!());
  }),
);
runs.sort((a, b) => SENTENCES.findIndex(([, s]) => s === a.sentence) - SENTENCES.findIndex(([, s]) => s === b.sentence) || a.repeat - b.repeat);
const price = BUILTIN_CATALOG.providers.flatMap((p) => p.models).find((m) => m.id === model)?.price;
const cost = price ? ((input - cacheRead) * price.input + cacheRead * (price.cacheRead ?? price.input) + output * price.output) / 1_000_000 : 0;
const subject = /^(用户|我|你|他|她|The user|User)/;
const lines: string[] = [];
for (const label of ['keep', 'either', 'skip', 'task'] as const) {
  const mine = runs.filter((r) => r.label === label);
  lines.push(`${label}: kept in ${mine.filter((r) => r.kept.length).length}/${mine.length} runs, ${mine.reduce((n, r) => n + r.kept.length, 0)} items`);
}
const all = runs.flatMap((r) => r.kept);
lines.push(`items with a subject: ${all.filter((t) => subject.test(t)).length}/${all.length}`);
lines.push(`model ${model} · ${repeats} repeats × ${SENTENCES.length} sentences · ${modelCalls} model calls · about ${cost.toFixed(4)} ${price?.currency ?? '?'}`);
writeFileSync(outFile, JSON.stringify({ model, repeats, summary: lines, runs, cost: { input, cacheRead, output, amount: cost, currency: price?.currency } }, null, 2), 'utf8');
console.log(lines.join('\n'));
for (const r of runs) console.log(`${r.label}\t${r.repeat}\t${r.sentence}\t→ ${r.kept.join(' | ') || '—'}`);
