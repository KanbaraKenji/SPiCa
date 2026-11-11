// In a turn that read outside content, does a real save still get through?
// Each "keep" sentence from keyword-memory.ts is sent together with a request
// to read a harmless file first, so the remember call usually comes after
// outside content. Counts the remember calls made after the file was read,
// the ones refused for straying from the user's words, and whether the item
// was kept in the end (after the model rewrote it). Prints a summary with the
// cost (catalog prices).
//
//   node --env-file=../../.env.local scripts/outside-turn-memory.ts [model] [repeats]
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_CATALOG } from '../src/catalog/builtin.ts';
import { MEMORY_LIMITS } from '../src/memory.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai.ts';
import { Runtime } from '../src/runtime.ts';

const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
const apiKey = process.env.SPICA_OPENAI_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('usage: node --env-file=… scripts/outside-turn-memory.ts [model] [repeats]');
  process.exit(2);
}
const model = process.argv[2] ?? 'deepseek-flash';
const repeats = Number(process.argv[3] ?? 2);
const outFile = process.argv[4];

const KEEP = [
  '我是做磁性元件设计的工程师。',
  '以后给我写代码都用 TypeScript。',
  '我习惯先看结论再看过程。',
  '我在深圳上班，用的是北京时间。',
  '别再用表情符号回复我了。',
  '我们团队的周会固定在周一上午十点。',
  '回答我的时候总是附上信息来源。',
  '我不喜欢太长的回答，三五句话就够。',
  '我负责公司的开单系统和磁件设计两个项目。',
  '我看东西多半用手机，表格别太宽。',
  '我写英文邮件一般要用正式的语气。',
  '我做采购决定时最看重交期。',
];

const root = await mkdtemp(join(tmpdir(), 'spica-outside-turn-'));
writeFileSync(join(root, 'note.txt'), '会议纪要\n\n1. 样机评审改到 12 月 18 日。\n2. 模具厂确认开模 35 天。\n3. 下周起每周五发进度。\n');

let input = 0;
let output = 0;
let cacheRead = 0;
let modelCalls = 0;
interface Run { sentence: string; repeat: number; afterRead: number; strayRefused: number; otherRefused: string[]; kept: string[] }
const runs: Run[] = [];

async function one(sentence: string, repeat: number): Promise<Run> {
  const rt = new Runtime({
    providers: [new OpenAICompatibleProvider({ id: 'openai', baseUrl: baseUrl!, apiKey: apiKey! })],
    defaults: { providerId: 'openai', model, maxTokens: 800, maxTurns: 6 },
    cwd: root,
    budget: { perRunUsd: 0.1 },
    redactions: [apiKey, baseUrl],
  });
  let read = false;
  let afterRead = 0;
  let strayRefused = 0;
  const otherRefused: string[] = [];
  rt.events.on((e) => {
    if (e.type === 'usage') {
      modelCalls++;
      input += e.usage.inputTokens;
      output += e.usage.outputTokens;
      cacheRead += e.usage.cacheReadTokens ?? 0;
    }
    if (e.type === 'tool.end' && e.name === 'read_file') read = true;
    if (e.type === 'tool.start' && e.name === 'remember' && read) afterRead++;
    if (e.type === 'tool.end' && e.name === 'remember' && e.isError) {
      if (/at least half of the sentence/.test(e.preview)) strayRefused++;
      else otherRefused.push(e.preview.replace(/^\[fetched at [^\]]+\]\n/, '').slice(0, 120));
    }
  });
  const s = rt.createSession();
  await s.send(`先读一下 note.txt，告诉我里面说了什么。读完以后再记住一件事：${sentence}`).done;
  const kept = rt.memory.list().map((m) => m.text);
  await rt.close();
  return { sentence, repeat, afterRead, strayRefused, otherRefused, kept };
}

const jobs: (() => Promise<Run>)[] = [];
for (let r = 1; r <= repeats; r++) for (const s of KEEP) jobs.push(() => one(s, r));
let next = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < jobs.length) runs.push(await jobs[next++]!());
  }),
);
await rm(root, { recursive: true, force: true });

const price = BUILTIN_CATALOG.providers.flatMap((p) => p.models).find((m) => m.id === model)?.price;
const cost = price ? (input - cacheRead) * (price.input / 1e6) + cacheRead * ((price.cacheRead ?? price.input) / 1e6) + output * (price.output / 1e6) : NaN;
const tainted = runs.filter((r) => r.afterRead > 0);
const lines = [
  `threshold ${MEMORY_LIMITS.outsideTurnOverlap} · ${runs.length} runs · remember called after the file was read in ${tainted.length}`,
  `of those: refused at least once for straying ${tainted.filter((r) => r.strayRefused > 0).length}, kept in the end ${tainted.filter((r) => r.kept.length > 0).length}, ` +
    `refused for straying and then kept after a rewrite ${tainted.filter((r) => r.strayRefused > 0 && r.kept.length > 0).length}, lost ${tainted.filter((r) => r.kept.length === 0).length}`,
  `all runs kept ${runs.filter((r) => r.kept.length > 0).length}/${runs.length}; other refusals: ${runs.flatMap((r) => r.otherRefused).join(' | ') || '-'}`,
  `model ${model} · ${modelCalls} model calls · input ${input} (cache read ${cacheRead}) · output ${output} · about ${cost.toFixed(4)} ${price?.currency ?? '?'}`,
];
if (outFile) writeFileSync(outFile, JSON.stringify({ model, repeats, runs, summary: lines }, null, 2), 'utf8');
console.log(lines.join('\n'));
