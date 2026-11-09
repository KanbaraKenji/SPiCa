// J2 with a real model: the top-level agent reads a PDF, a Word file and an Excel
// workbook from a folder and answers; file.card events show which files it read.
//
//   npm run smoke:extract:agent -w @spica/extract     (DeepSeek from .env.local)
//
// Keys come from the environment (--env-file); nothing secret is printed.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatibleProvider, Runtime } from '@spica/core';
import type { CoreEvent, FileCardMeta } from '@spica/protocol';
import { createExtractors } from '../src/index.ts';
import { writeSamples } from '../src/testing/fixtures.ts';

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`missing ${name} (expected in .env.local)`);
    process.exit(2);
  }
  return v;
};

const model = process.env.SPICA_OPENAI_MODEL ?? 'deepseek-flash';
const provider = new OpenAICompatibleProvider({ id: 'openai', baseUrl: env('SPICA_OPENAI_BASE_URL'), apiKey: env('SPICA_OPENAI_API_KEY') });
const dir = await mkdtemp(join(tmpdir(), 'spica-j2-'));
await writeSamples(dir);

const rt = new Runtime({
  providers: [provider],
  defaults: { providerId: provider.id, model, maxTokens: 1024, maxTurns: 8 },
  cwd: dir,
  extractors: createExtractors(),
  budget: { perRunUsd: 0.2 },
});

const cards: FileCardMeta[] = [];
const log: string[] = [];
const t0 = Date.now();
const stamp = () => `${String(Date.now() - t0).padStart(6)}ms`;
rt.events.on((e: CoreEvent) => {
  if (e.type === 'tool.start') log.push(`${stamp()} tool ▶ ${e.name} ${JSON.stringify(e.input)}`);
  if (e.type === 'tool.end') log.push(`${stamp()} tool ■ ${e.name} ${e.isError ? 'ERROR' : 'ok'} ${e.durationMs}ms`);
  if (e.type === 'file.card') {
    cards.push(e.file);
    log.push(`${stamp()} card  ${e.file.name} · ${e.file.kind} · read ${JSON.stringify(e.file.read)}`);
  }
  if (e.type === 'usage') log.push(`${stamp()} usage in=${e.usage.inputTokens} out=${e.usage.outputTokens} ≈$${e.costUsd.toFixed(5)}`);
  if (e.type === 'run.end') log.push(`${stamp()} run.end ${e.reason}`);
});

const session = rt.createSession({ title: 'J2 smoke', tools: ['read_file', 'list_dir', 'glob'] });
const result = await session.send(
  '工作文件夹里有一份报价单（PDF）、一份会议纪要（Word）和一份库存表（Excel）。请读这三个文件后用中文简短回答：' +
    '1）报价有效期到哪天？2）会议待办里谁负责更新报价单模板？3）库存表里无线键盘的数量是多少？',
).done;

console.log(`\n== J2 smoke: ${model} ==`);
console.log(log.join('\n'));
console.log(`\nanswer:\n${result.text}`);
const kinds = new Set(cards.map((c) => c.kind));
const checks = {
  completed: result.reason === 'completed',
  readPdf: kinds.has('pdf'),
  readDocx: kinds.has('docx'),
  readXlsx: kinds.has('xlsx'),
  validUntil: /2026\s*[-年./]\s*12\s*[-月./]\s*31/.test(result.text),
  owner: /小李/.test(result.text),
  keyboards: /150/.test(result.text),
};
const ok = Object.values(checks).every(Boolean);
console.log(`\n${JSON.stringify(checks)}  total ≈$${rt.ledger.globalUsd.toFixed(5)}  → ${ok ? 'PASS' : 'FAIL'}`);
await rm(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
