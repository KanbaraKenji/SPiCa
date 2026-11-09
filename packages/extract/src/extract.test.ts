import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExtractError, createExtractors, extractFile } from './index.ts';
import { decodeText, csvRecords, sniffDelimiter } from './text.ts';
import {
  MINUTES,
  QUOTE_PAGES,
  SALES_CSV,
  WEEKLY_SLIDES,
  encodeGbk,
  makeBigXlsx,
  makeDocx,
  makeInventoryXlsx,
  makePdf,
  makePptx,
  makeScannedPdf,
} from './testing/fixtures.ts';
import { formatKind, serialToText } from './xlsx.ts';
import { formatRanges, parseRanges } from './util.ts';

let dir: string;
const f = (name: string) => join(dir, name);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spica-extract-'));
  const bigPdf = Array.from({ length: 120 }, (_, p) => Array.from({ length: 30 }, (_, l) => `第 ${p + 1} 页第 ${l + 1} 行：示例正文。`));
  const files: [string, Uint8Array | string][] = [
    ['quote.pdf', await makePdf(QUOTE_PAGES, { outline: [{ title: '报价明细', page: 1 }, { title: '付款与交付', page: 2 }] })],
    ['big.pdf', await makePdf(bigPdf, { outline: [{ title: '开头', page: 1 }, { title: '结尾', page: 120 }] })],
    ['scan.pdf', await makeScannedPdf(3)],
    ['minutes.docx', await makeDocx(MINUTES)],
    [
      'long.docx',
      await makeDocx({
        title: '汇编',
        sections: Array.from({ length: 150 }, (_, s) => ({ heading: `第 ${s + 1} 章`, paragraphs: Array.from({ length: 8 }, (_, k) => `第 ${s + 1} 章第 ${k + 1} 段，示例内容。`) })),
      }),
    ],
    ['inventory.xlsx', await makeInventoryXlsx()],
    ['big.xlsx', await makeBigXlsx(2, 5000)],
    ['weekly.pptx', makePptx(WEEKLY_SLIDES)],
    ['big.pptx', makePptx(Array.from({ length: 120 }, (_, i) => ({ title: `第 ${i + 1} 页`, body: Array.from({ length: 15 }, (_, k) => `要点 ${k + 1}：示例文字`) })))],
    ['sales-gbk.csv', encodeGbk(SALES_CSV)],
    ['sales-semicolon.csv', '名称;数量\n苹果;3\n香蕉;5\n'],
    ['big.csv', `编号,金额\n${Array.from({ length: 30_000 }, (_, i) => `${i + 1},${i * 3}`).join('\n')}\n`],
    ['memo-gbk.txt', encodeGbk('备忘录\r\n周五前发出报价单。\r\n')],
    ['notes-utf8.md', '# 标题\n\n正文第一段。\n'],
    ['notes-utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('双字节编码的备忘\n', 'utf16le')])],
    ['big.txt', Array.from({ length: 20_000 }, (_, i) => `第 ${i + 1} 行`).join('\n')],
    ['garbage.pdf', 'this is not a pdf at all'],
    ['garbage.docx', 'PK\u0003\u0004 not really a zip'],
    ['garbage.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5])],
    ['garbage.pptx', 'hello'],
    ['binary.txt', Buffer.from([0x41, 0x00, 0x42, 0x00, 0x00, 0x01])],
  ];
  for (const ext of ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt']) files.push([`empty.${ext}`, '']);
  for (const [name, data] of files) await writeFile(f(name), data);
  // Truncated copies of real files.
  const { readFile } = await import('node:fs/promises');
  for (const name of ['quote.pdf', 'minutes.docx', 'inventory.xlsx', 'weekly.pptx']) {
    const buf = await readFile(f(name));
    await writeFile(f(`cut-${name}`), buf.subarray(0, Math.floor(buf.length / 3)));
  }
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SMALL = { maxChars: 8000 };

describe('PDF', () => {
  it('reads every page with Chinese text and card metadata', async () => {
    const r = await extractFile(f('quote.pdf'));
    expect(r.text).toContain('PDF, 2 pages.');
    expect(r.text).toContain('=== page 1 ===');
    expect(r.text).toContain('报价编号：Q-2026-0117');
    expect(r.text).toContain('付款方式：预付 30%');
    expect(r.meta).toMatchObject({ kind: 'pdf', name: 'quote.pdf', pageCount: 2, read: { pages: '1-2' } });
    expect(r.meta.extractedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
    expect(r.meta.modifiedAt).toMatch(/[+-]\d\d:\d\d$/);
    expect(r.truncated).toBeFalsy();
  });

  it('reads only the requested pages', async () => {
    const r = await extractFile(f('quote.pdf'), { pages: '2' });
    expect(r.text).not.toContain('报价编号');
    expect(r.text).toContain('交货期');
    expect(r.meta.read.pages).toBe('2');
  });

  it('reports an empty file', async () => {
    const r = await extractFile(f('empty.pdf'));
    expect(r.text).toMatch(/empty \(0 bytes\)/);
    expect(r.meta.kind).toBe('pdf');
  });

  it('throws a readable error for damaged files', async () => {
    await expect(extractFile(f('garbage.pdf'))).rejects.toThrow(ExtractError);
    await expect(extractFile(f('garbage.pdf'))).rejects.toThrow(/Not a readable PDF/);
    // pdf.js repairs what it can; a truncated file either reads partly or fails cleanly.
    const cut = await extractFile(f('cut-quote.pdf')).catch((e: unknown) => e);
    if (cut instanceof Error) expect(cut).toBeInstanceOf(ExtractError);
    else expect(typeof (cut as { text: string }).text).toBe('string');
  });

  it('chunks a large PDF by page and lists what is left', async () => {
    const r = await extractFile(f('big.pdf'), SMALL);
    expect(r.text.length).toBeLessThanOrEqual(SMALL.maxChars);
    expect(r.truncated).toBe(true);
    expect(r.meta.truncated).toBe(true);
    const shown = r.meta.read.pages!;
    const lastShown = Number(shown.split('-').at(-1));
    expect(lastShown).toBeLessThan(120);
    expect(r.text).toContain(`Not shown: pages ${lastShown + 1}-120`);
    expect(r.text).toContain('Outline:');
    expect(r.text).toContain('- 结尾 (page 120)');
    const next = await extractFile(f('big.pdf'), { ...SMALL, pages: `${lastShown + 1}-${lastShown + 2}` });
    expect(next.text).toContain(`第 ${lastShown + 1} 页第 1 行`);
  });

  it('says plainly when there is no text layer (scanned)', async () => {
    const r = await extractFile(f('scan.pdf'));
    expect(r.meta.noTextLayer).toBe(true);
    expect(r.text).toMatch(/no text layer/);
    expect(r.text).toMatch(/OCR is not available/);
  });

  it('rejects bad page ranges with a fixable message', async () => {
    await expect(extractFile(f('quote.pdf'), { pages: '9' })).rejects.toThrow(/file has 2 pages/);
    await expect(extractFile(f('quote.pdf'), { pages: 'abc' })).rejects.toThrow(/Invalid page range/);
  });
});

describe('Word', () => {
  it('keeps headings, lists and tables in numbered blocks', async () => {
    const r = await extractFile(f('minutes.docx'));
    expect(r.text).toContain('[1] # 周例会会议纪要');
    expect(r.text).toContain('## 二、讨论事项');
    expect(r.text).toContain('- 库存表格式统一为每周一更新');
    expect(r.text).toContain('| 整理首页改版意见 | 小王 | 11 月 7 日 |');
    expect(r.meta).toMatchObject({ kind: 'docx', blockCount: 12, read: { blocks: '1-12' } });
  });

  it('reports an empty file', async () => {
    const r = await extractFile(f('empty.docx'));
    expect(r.text).toMatch(/empty \(0 bytes\)/);
  });

  it('throws a readable error for damaged files', async () => {
    await expect(extractFile(f('garbage.docx'))).rejects.toThrow(/Not a readable Word document/);
    await expect(extractFile(f('cut-minutes.docx'))).rejects.toThrow(ExtractError);
  });

  it('chunks a long document by block and outlines the rest', async () => {
    const r = await extractFile(f('long.docx'), SMALL);
    expect(r.text.length).toBeLessThanOrEqual(SMALL.maxChars);
    expect(r.truncated).toBe(true);
    const last = Number(r.meta.read.blocks!.split('-')[1]);
    expect(r.text).toContain(`offset=${last + 1}`);
    expect(r.text).toContain('Headings not shown (block numbers):');
    const next = await extractFile(f('long.docx'), { ...SMALL, offset: last + 1, limit: 5 });
    expect(next.meta.read.blocks).toBe(`${last + 1}-${last + 5}`);
    expect(next.text).toContain(`[${last + 1}]`);
  });
});

describe('Excel', () => {
  it('lays out every sheet with row numbers, column letters, dates and percents', async () => {
    const r = await extractFile(f('inventory.xlsx'));
    expect(r.text).toContain('Excel workbook, 4 sheets: 1 "库存" (A1:F7); 2 "进货记录" (A1:D3); 3 "空白页" (empty); 4 "说明" (A1:B3).');
    expect(r.text).toContain('row\tA\tB\tC\tD\tE\tF');
    expect(r.text).toContain('2\t便携显示器\t15.6 英寸\t20\t899\t2026-10-12\t25%');
    expect(r.text).toContain('6\t桌面支架\t铝合金\t80\t89.5\t2026-11-05\t10%');
    expect(r.text).toContain('7\t合计\t\t345');
    expect(r.text).toContain('2\t2026-10-12 14:30\t示例供应商甲');
    expect(r.text).toContain('3\t\tTRUE');
    expect(r.meta.sheets).toEqual([
      { name: '库存', rows: 7, cols: 6, range: 'A1:F7' },
      { name: '进货记录', rows: 3, cols: 4, range: 'A1:D3' },
      { name: '空白页', rows: 0, cols: 0 },
      { name: '说明', rows: 3, cols: 2, range: 'A1:B3' },
    ]);
  });

  it('reads one sheet by name or number, and a row window with the header kept', async () => {
    const byName = await extractFile(f('inventory.xlsx'), { sheet: '进货记录' });
    expect(byName.text).not.toContain('便携显示器\t15.6');
    expect(byName.meta.read).toEqual({ sheet: '进货记录', rows: '1-3', range: 'A1:D3' });
    const byIndex = await extractFile(f('inventory.xlsx'), { sheet: '1', offset: 4, limit: 2 });
    expect(byIndex.text).toContain('(header) 1\t品名');
    expect(byIndex.text).toContain('4\tUSB-C 扩展坞');
    expect(byIndex.text).toContain('5\t降噪耳机');
    expect(byIndex.text).not.toContain('6\t桌面支架');
    expect(byIndex.meta.read).toEqual({ sheet: '库存', rows: '4-5', range: 'A4:F5' });
    await expect(extractFile(f('inventory.xlsx'), { sheet: '不存在' })).rejects.toThrow(/Sheets: 1 "库存", 2 "进货记录"/);
  });

  it('reports an empty file', async () => {
    const r = await extractFile(f('empty.xlsx'));
    expect(r.text).toMatch(/empty \(0 bytes\)/);
  });

  it('throws a readable error for damaged files', async () => {
    await expect(extractFile(f('garbage.xlsx'))).rejects.toThrow(/Not a readable Excel workbook/);
    await expect(extractFile(f('cut-inventory.xlsx'))).rejects.toThrow(ExtractError);
  });

  it('chunks big sheets and says how to continue', async () => {
    const r = await extractFile(f('big.xlsx'), SMALL);
    expect(r.text.length).toBeLessThanOrEqual(SMALL.maxChars);
    expect(r.truncated).toBe(true);
    expect(r.meta.sheets?.map((s) => s.rows)).toEqual([5001, 5001]);
    const last = Number(r.meta.read.rows!.split('-')[1]);
    expect(r.text).toContain(`sheet="月份1" offset=${last + 1}`);
    const next = await extractFile(f('big.xlsx'), { ...SMALL, sheet: '月份2', offset: 4000, limit: 10 });
    expect(next.text).toContain('4000\t3999\t示例商品 2-3999');
    expect(next.meta.read.rows).toBe('4000-4009');
  });
});

describe('PowerPoint', () => {
  it('reads slides, tables and speaker notes', async () => {
    const r = await extractFile(f('weekly.pptx'));
    expect(r.text).toContain('=== slide 1 ===\n项目周报\n第 45 周');
    expect(r.text).toContain('Notes: 开场先说明本周整体进度正常。');
    expect(r.text).toContain('| 确定配色 | 小王 |');
    expect(r.meta).toMatchObject({ kind: 'pptx', slideCount: 3, read: { pages: '1-3' } });
    const one = await extractFile(f('weekly.pptx'), { pages: '2' });
    expect(one.text).toContain('本周完成');
    expect(one.text).not.toContain('项目周报\n');
  });

  it('reports an empty file', async () => {
    const r = await extractFile(f('empty.pptx'));
    expect(r.text).toMatch(/empty \(0 bytes\)/);
  });

  it('throws a readable error for damaged files', async () => {
    await expect(extractFile(f('garbage.pptx'))).rejects.toThrow(/Not a readable PowerPoint file/);
    await expect(extractFile(f('cut-weekly.pptx'))).rejects.toThrow(ExtractError);
  });

  it('chunks many slides', async () => {
    const r = await extractFile(f('big.pptx'), SMALL);
    expect(r.text.length).toBeLessThanOrEqual(SMALL.maxChars);
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/Not shown: slides \d+-120/);
  });
});

describe('CSV and text', () => {
  it('detects GBK and quoted fields in CSV', async () => {
    const r = await extractFile(f('sales-gbk.csv'));
    expect(r.meta.encoding).toBe('gbk');
    expect(r.text).toContain('1\t门店\t日期\t销售额（元）\t备注');
    expect(r.text).toContain('2\t一号店\t2026-11-01\t12800\t周末促销, 客流较多');
    expect(r.meta).toMatchObject({ kind: 'csv', read: { rows: '1-4', range: 'A1:D4' } });
  });

  it('sniffs other delimiters', async () => {
    const r = await extractFile(f('sales-semicolon.csv'));
    expect(r.text).toContain('2\t苹果\t3');
  });

  it('reads GBK, UTF-8 and UTF-16 text', async () => {
    const gbk = await extractFile(f('memo-gbk.txt'));
    expect(gbk.meta.encoding).toBe('gbk');
    expect(gbk.text).toContain('     2\t周五前发出报价单。');
    const md = await extractFile(f('notes-utf8.md'));
    expect(md.meta.encoding).toBe('utf-8');
    expect(md.text).toContain('     1\t# 标题');
    const u16 = await extractFile(f('notes-utf16.txt'));
    expect(u16.meta.encoding).toBe('utf-16le');
    expect(u16.text).toContain('双字节编码的备忘');
  });

  it('reports empty files', async () => {
    expect((await extractFile(f('empty.csv'))).text).toMatch(/empty \(0 bytes\)/);
    expect((await extractFile(f('empty.txt'))).text).toMatch(/empty \(0 bytes\)/);
  });

  it('refuses binary content under a text extension', async () => {
    await expect(extractFile(f('binary.txt'))).rejects.toThrow(/binary file/);
  });

  it('chunks big CSV and text files', async () => {
    const csv = await extractFile(f('big.csv'), SMALL);
    expect(csv.text.length).toBeLessThanOrEqual(SMALL.maxChars);
    expect(csv.truncated).toBe(true);
    const last = Number(csv.meta.read.rows!.split('-')[1]);
    expect(csv.text).toContain(`offset=${last + 1}`);
    const txt = await extractFile(f('big.txt'), { ...SMALL, offset: 19_999 });
    expect(txt.text).toContain(' 20000\t第 20000 行');
    expect(txt.truncated).toBe(false);
    const head = await extractFile(f('big.txt'), SMALL);
    expect(head.truncated).toBe(true);
    expect(head.text.length).toBeLessThanOrEqual(SMALL.maxChars);
  });
});

describe('helpers', () => {
  it('parses and formats page ranges', () => {
    expect(parseRanges('1,4,7-9', 10, 'page')).toEqual([1, 4, 7, 8, 9]);
    expect(parseRanges('8-20', 10, 'page')).toEqual([8, 9, 10]);
    expect(formatRanges([1, 2, 3, 5, 7, 8])).toBe('1-3,5,7-8');
  });

  it('classifies number formats and converts serial dates', () => {
    expect(formatKind('yyyy/mm/dd')).toBe('date');
    expect(formatKind('yyyy"年"m"月"d"日"')).toBe('date');
    expect(formatKind('[$-zh-CN]h:mm')).toBe('time');
    expect(formatKind('#,##0.00')).toBeUndefined();
    expect(formatKind('0.0%')).toBe('percent');
    expect(serialToText(46335, 'date', false)).toBe('2026-11-09');
    expect(serialToText(0.5, 'time', false)).toBe('12:00:00');
  });

  it('decodes and splits CSV', () => {
    expect(decodeText(encodeGbk('中文')).encoding).toBe('gbk');
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect([...csvRecords('a,"b ""q"", c"\n"多\n行",2', ',')]).toEqual([
      ['a', 'b "q", c'],
      ['多\n行', '2'],
    ]);
  });

  it('createExtractors covers every format once', () => {
    const exts = createExtractors().flatMap((e) => e.extensions);
    expect(new Set(exts).size).toBe(exts.length);
    for (const e of ['.pdf', '.docx', '.xlsx', '.xlsm', '.pptx', '.csv', '.tsv', '.txt', '.md']) expect(exts).toContain(e);
  });
});
