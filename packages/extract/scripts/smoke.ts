// Smoke run of the extractors through the kernel's real read_file tool.
// Writes the sample folder (everyday + big files), reads each file once and a
// follow-up chunk of the big ones, and prints a summary, the file card and timing.
//
//   npm run smoke:extract -w @spica/extract              (samples in a temp folder)
//   npm run smoke:extract -w @spica/extract -- <folder>  (read every file in <folder> instead)
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, Tracer, readFileTool, type ToolContext } from '@spica/core';
import type { CoreEventBody, FileCardMeta } from '@spica/protocol';
import { createExtractors, formatFor } from '../src/index.ts';
import { writeSamples } from '../src/testing/fixtures.ts';

const given = process.argv[2];
const dir = given ?? (await mkdtemp(join(tmpdir(), 'spica-extract-smoke-')));
if (!given) await writeSamples(dir, { big: true });

let card: FileCardMeta | undefined;
const ctx: ToolContext = {
  sessionId: 'smoke',
  parentChain: [],
  cwd: dir,
  signal: new AbortController().signal,
  tracer: new Tracer(new MemoryStore()),
  extractors: createExtractors(),
  services: {},
  callId: 'smoke',
  emit: (e: CoreEventBody) => {
    if (e.type === 'file.card') card = e.file;
  },
};

function cardLine(c: FileCardMeta | undefined): string {
  if (!c) return 'card: (none)';
  const size = c.pageCount !== undefined ? `${c.pageCount} pages` : c.slideCount !== undefined ? `${c.slideCount} slides` : c.sheets ? `${c.sheets.length} sheet(s)` : '';
  const flags = [c.truncated && 'truncated', c.noTextLayer && 'no text layer', c.encoding && `encoding ${c.encoding}`].filter(Boolean).join(', ');
  return `card: ${c.kind} · ${size} · read ${JSON.stringify(c.read)}${flags ? ` · ${flags}` : ''}`;
}

const rows: string[] = [];
let failed = 0;
async function read(name: string, input: Record<string, unknown> = {}): Promise<void> {
  card = undefined;
  const t0 = performance.now();
  let content: string;
  let status = 'ok';
  try {
    const r = await readFileTool.execute({ path: name, ...input }, ctx);
    content = r.content;
    if (r.isError) status = 'ERROR';
  } catch (err) {
    content = `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
    status = 'FAILED';
  }
  const ms = Math.round(performance.now() - t0);
  const lines = content.split('\n');
  const args = Object.keys(input).length ? ` ${JSON.stringify(input)}` : '';
  console.log(`\n── ${name}${args}  ${status}  ${ms} ms  ${content.length} chars`);
  console.log(lines.slice(0, 3).map((l) => `   ${l.slice(0, 140)}`).join('\n'));
  const tail = lines.at(-1)!;
  if (lines.length > 3 && tail.startsWith('[')) console.log(`   … ${tail.slice(0, 160)}`);
  console.log(`   ${cardLine(card)}`);
  rows.push(`${String(ms).padStart(6)} ms  ${status.padEnd(6)} ${String(content.length).padStart(7)} chars  ${name}${args}`);
  if (status === 'FAILED' && !name.startsWith('坏')) failed++;
}

const names = (await readdir(dir)).filter((n) => formatFor(n)).sort();
for (const n of names) await read(n);
if (!given) {
  await read('大报告.pdf', { pages: '150-151' });
  await read('长纪要.docx', { offset: 2000, limit: 20 });
  await read('大库存.xlsx', { sheet: '月份3', offset: 19_990, limit: 20 });
  await read('大周报.pptx', { pages: '200' });
  await read('大流水.csv', { offset: 49_995 });
}

console.log('\n== summary (read_file → @spica/extract) ==');
console.log(rows.join('\n'));
console.log(`\n${names.length} files, ${rows.length} reads, ${failed} unexpected failures → ${failed ? 'FAIL' : 'PASS'}`);
if (!given) await rm(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
