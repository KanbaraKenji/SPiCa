// Does a keyword hint help the model decide what to remember? Thirty
// sentences (worth keeping, not worth keeping, in between) are each sent as
// the first message of a fresh assistant conversation with an empty memory,
// in two groups: no hint, and a hint added to the system prompt when the
// message contains 记住 / 以后 / 总是 / 别再. Counts, per group, the sentences
// where the model called remember and where the runtime kept the item, and
// how close each kept sentence is to the user's words (the share used in
// turns that read outside content). Writes a JSON file with every run and
// prints a summary with the cost (catalog prices).
//
//   node --env-file=../../.env.local scripts/keyword-memory.ts <out.json> [model] [repeats]
import { writeFileSync } from 'node:fs';
import { BUILTIN_CATALOG } from '../src/catalog/builtin.ts';
import { MEMORY_LIMITS, overlap } from '../src/memory.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai.ts';
import { Runtime } from '../src/runtime.ts';

const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
const apiKey = process.env.SPICA_OPENAI_API_KEY;
const outFile = process.argv[2];
if (!baseUrl || !apiKey || !outFile) {
  console.error('usage: node --env-file=… scripts/keyword-memory.ts <out.json> [model] [repeats]');
  process.exit(2);
}
const model = process.argv[3] ?? 'deepseek-flash';
const repeats = Number(process.argv[4] ?? 3);
/** Only the sentences containing this text (to look at one more closely). */
const only = process.argv[5];

type Label = 'keep' | 'skip' | 'either';
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
  ['either', '我下个月要出差去德国两周。'],
  ['either', '最近在学日语。'],
  ['either', '我老板不喜欢 PPT 里有动画。'],
  ['either', '这个项目的截止日期是 12 月 15 日。'],
  ['either', '我一般晚上十一点以后就不看消息了。'],
  ['either', '我更喜欢用 Windows。'],
];
const KEYWORDS = /记住|以后|总是|别再/;
const HINT =
  'The user\'s latest message contains one of the words 记住 / 以后 / 总是 / 别再. Check whether it tells you something stable about the user ' +
  'or how they want you to work; if so, save it with remember.';

let input = 0;
let output = 0;
let cacheRead = 0;
let modelCalls = 0;

interface Run {
  group: 'plain' | 'hint';
  label: Label;
  sentence: string;
  keyword: boolean;
  repeat: number;
  called: boolean;
  kept: string[];
  refused: string[];
  overlaps: number[];
  /** Every tool the model called, in order. */
  tools: string[];
  reason: string;
}

async function one(group: Run['group'], label: Label, sentence: string, repeat: number): Promise<Run> {
  const rt = new Runtime({
    providers: [new OpenAICompatibleProvider({ id: 'openai', baseUrl: baseUrl!, apiKey: apiKey! })],
    defaults: { providerId: 'openai', model, maxTokens: 800, maxTurns: 4 },
    cwd: process.cwd(),
    budget: { perRunUsd: 0.1 },
    redactions: [apiKey, baseUrl],
  });
  if (group === 'hint') {
    rt.hooks.register('script:keyword-hint', {
      inject: (ctx) => {
        const last = rt.session(ctx.session.id)?.messages().filter((m) => m.kind === 'user').at(-1);
        const text = last?.content.map((b) => (b.type === 'text' ? b.text : '')).join('') ?? '';
        return KEYWORDS.test(text) ? [{ position: 'system:after', text: HINT, priority: 30 }] : undefined;
      },
    });
  }
  let called = false;
  const tools: string[] = [];
  const refused: string[] = [];
  rt.events.on((e) => {
    if (e.type === 'usage') {
      modelCalls++;
      input += e.usage.inputTokens;
      output += e.usage.outputTokens;
      cacheRead += e.usage.cacheReadTokens ?? 0;
    }
    if (e.type === 'tool.start') tools.push(e.name);
    if (e.type === 'tool.start' && e.name === 'remember') called = true;
    if (e.type === 'tool.end' && e.name === 'remember' && e.isError) refused.push(e.preview.replace(/^\[fetched at [^\]]+\]\n/, '').slice(0, 160));
  });
  const s = rt.createSession();
  const res = await s.send(sentence).done;
  const items = rt.memory.list();
  await rt.close();
  return {
    group,
    label,
    sentence,
    keyword: KEYWORDS.test(sentence),
    repeat,
    called,
    kept: items.map((m) => m.text),
    refused,
    overlaps: items.map((m) => Math.round(overlap(m.text, m.quote) * 100) / 100),
    tools,
    reason: res.reason,
  };
}

const jobs: (() => Promise<Run>)[] = [];
for (let r = 1; r <= repeats; r++) for (const g of ['plain', 'hint'] as const) for (const [l, s] of SENTENCES.filter(([, x]) => !only || x.includes(only))) jobs.push(() => one(g, l, s, r));
const runs: Run[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++]!;
      runs.push(await j());
    }
  }),
);

const price = BUILTIN_CATALOG.providers.flatMap((p) => p.models).find((m) => m.id === model)?.price;
const cost = price ? (input - cacheRead) * (price.input / 1e6) + cacheRead * ((price.cacheRead ?? price.input) / 1e6) + output * (price.output / 1e6) : NaN;

const rate = (xs: Run[], f: (r: Run) => boolean) => `${xs.filter(f).length}/${xs.length}`;
const lines: string[] = [];
for (const g of ['plain', 'hint'] as const) {
  const mine = runs.filter((r) => r.group === g);
  const by = (l: Label, kw?: boolean) => mine.filter((r) => r.label === l && (kw === undefined || r.keyword === kw));
  lines.push(
    `${g}: keep → kept ${rate(by('keep'), (r) => r.kept.length > 0)} (with keyword ${rate(by('keep', true), (r) => r.kept.length > 0)}, without ${rate(by('keep', false), (r) => r.kept.length > 0)}) · ` +
      `skip → called ${rate(by('skip'), (r) => r.called)}, kept ${rate(by('skip'), (r) => r.kept.length > 0)} (with keyword kept ${rate(by('skip', true), (r) => r.kept.length > 0)}) · ` +
      `either → kept ${rate(by('either'), (r) => r.kept.length > 0)}`,
  );
}
const ov = runs.flatMap((r) => (r.label === 'keep' ? r.overlaps : []));
lines.push(
  `kept items from "keep" sentences: ${ov.length}; overlap with the user's words below ${MEMORY_LIMITS.outsideTurnOverlap} (would be refused in a turn that read outside content): ${ov.filter((x) => x < MEMORY_LIMITS.outsideTurnOverlap).length}; ` +
    `below 0.3: ${ov.filter((x) => x < 0.3).length}; below 0.4: ${ov.filter((x) => x < 0.4).length}; below 0.6: ${ov.filter((x) => x < 0.6).length}`,
);
lines.push(`model ${model} · ${repeats} repeats × 2 groups × ${SENTENCES.length} sentences · ${modelCalls} model calls · input ${input} (cache read ${cacheRead}) · output ${output} · about ${cost.toFixed(4)} ${price?.currency ?? '?'}`);
writeFileSync(outFile, JSON.stringify({ model, repeats, runs, summary: lines, cost: { input, cacheRead, output, amount: cost, currency: price?.currency } }, null, 2), 'utf8');
console.log(lines.join('\n'));
