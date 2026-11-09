// The extractors through the kernel's real read_file tool: pass-through text, file.card events.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, Tracer, readFileTool, type FileExtractor, type ToolContext } from '@spica/core';
import type { CoreEventBody, FileCardMeta } from '@spica/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExtractors } from './index.ts';
import { writeSamples } from './testing/fixtures.ts';

let dir: string;
let events: CoreEventBody[];
let ctx: ToolContext;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spica-readfile-'));
  await writeSamples(dir);
  // Type check: our extractors are the kernel's FileExtractor.
  const extractors: FileExtractor[] = createExtractors();
  events = [];
  ctx = {
    sessionId: 's',
    parentChain: [],
    cwd: dir,
    signal: new AbortController().signal,
    tracer: new Tracer(new MemoryStore()),
    extractors,
    services: {},
    callId: 'call-1',
    emit: (e) => events.push(e),
  };
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lastCard(): FileCardMeta {
  const e = events.filter((x) => x.type === 'file.card').at(-1);
  if (!e || e.type !== 'file.card') throw new Error('no file.card event');
  return e.file;
}

describe('read_file with @spica/extract', () => {
  it('PDF: passes the laid-out text through and emits a card', async () => {
    const r = await readFileTool.execute({ path: '报价单.pdf', pages: '2' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('报价单.pdf (pdf,');
    expect(r.content).toContain('read pages 2');
    expect(r.content).toContain('报价有效期：至 2026-12-31。');
    expect(r.content).not.toMatch(/^\s+1\t/m); // not re-numbered by line
    expect(lastCard()).toMatchObject({ kind: 'pdf', name: '报价单.pdf', pageCount: 2, read: { pages: '2' } });
  });

  it('Word and Excel: sheet and row requests reach the extractor', async () => {
    const doc = await readFileTool.execute({ path: '会议纪要.docx' }, ctx);
    expect(doc.content).toContain('| 更新报价单模板 | 小李 | 11 月 6 日 |');
    expect(lastCard().kind).toBe('docx');

    const xl = await readFileTool.execute({ path: '库存表.xlsx', sheet: '库存', offset: 3, limit: 1 }, ctx);
    expect(xl.content).toContain('3\t无线键盘\t静音款\t150');
    expect(xl.content).toContain('read sheet 库存, rows 3-3, A3:F3');
    expect(lastCard()).toMatchObject({ kind: 'xlsx', read: { sheet: '库存', rows: '3-3', range: 'A3:F3' } });
  });

  it('GBK CSV and scanned PDF', async () => {
    const csv = await readFileTool.execute({ path: '门店销售.csv' }, ctx);
    expect(csv.content).toContain('一号店');
    expect(lastCard()).toMatchObject({ kind: 'csv', encoding: 'gbk' });

    const scan = await readFileTool.execute({ path: '扫描件.pdf' }, ctx);
    expect(scan.isError).toBeFalsy();
    expect(scan.content).toContain('no text layer');
    expect(lastCard().noTextLayer).toBe(true);
  });

  it('damaged files come back as tool errors the model can read', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, '坏文件.xlsx'), 'not a workbook');
    await expect(readFileTool.execute({ path: '坏文件.xlsx' }, ctx)).rejects.toThrow(/Not a readable Excel workbook/);
  });
});
