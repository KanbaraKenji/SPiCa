import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CFB from 'cfb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractFile } from './index.ts';
import { MINUTES, makeDocx, makeInventoryXlsx, makePdf } from './testing/fixtures.ts';
import { makeDoc, makeScannedTextPdf, makeXls, xlsCell } from './testing/legacy-fixtures.ts';
import { rkValue } from './xls.ts';

let dir: string;

/** A Word 6.0 / 95 file: its information block is marked 0xA5DC. */
function word6(): Uint8Array {
  const doc = CFB.utils.cfb_new();
  const word = Buffer.alloc(1024);
  word.writeUInt16LE(0xa5dc, 0);
  word.writeUInt16LE(0x0065, 2);
  CFB.utils.cfb_add(doc, 'WordDocument', word);
  return new Uint8Array(CFB.write(doc, { type: 'buffer', fileType: 'cfb' }) as Buffer);
}
const f = (name: string) => join(dir, name);

const SHARED = ['物料', '数量', '入库日期', '六角螺栓 M8', 'Washer', '示例供应商的一条很长的备注文字'];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spica-legacy-'));
  const xls = makeXls(
    [
      {
        name: '库存',
        cells: [
          xlsCell.sst(0, 0, 0),
          xlsCell.sst(0, 1, 1),
          xlsCell.sst(0, 2, 2),
          xlsCell.sst(1, 0, 3),
          xlsCell.rk(1, 1, 120),
          xlsCell.number(1, 2, 46335, 1), // 2026-11-09
          xlsCell.sst(2, 0, 4),
          xlsCell.number(2, 1, 2.5),
          xlsCell.number(2, 2, 46336.5, 1),
          xlsCell.mulrk(3, 0, [7, 8, 9]),
          xlsCell.formula(4, 1, 129.5),
          xlsCell.formulaText(4, 2, '合计'),
          xlsCell.bool(5, 0, true),
          xlsCell.error(5, 1, 0x07),
          xlsCell.number(5, 2, 0.25, 2),
          xlsCell.label(6, 0, 'old label 旧'),
          xlsCell.sst(7, 3, 5),
        ],
      },
      { name: 'Notes', cells: [xlsCell.label(0, 0, 'second sheet')] },
      { name: 'hidden one', hidden: true, cells: [] },
    ],
    SHARED,
    { sstSplitAt: 5, embedded: true },
  );
  const rows = Array.from({ length: 60 }, (_, i) => xlsCell.rk(i, 0, i + 1));
  const files: [string, Uint8Array | string][] = [
    ['stock.xls', xls],
    ['long.xls', makeXls([{ name: 'S', cells: rows }], [])],
    ['renamed.xls', await makeInventoryXlsx()],
    ['table.xls', '名称\t数量\n螺栓\t3\n'],
    [
      'minutes.doc',
      makeDoc([
        '周例会纪要',
        '参会：ALEX.CHEN、示例团队。',
        'Page {PAGE|3} of the notes',
        { cells: [['事项', '负责人'], ['报价单\n第二行', 'ALEX.CHEN'], ['', '空格']] },
        '会后补充一行。',
        'Chart: {EMBED Excel.Sheet.8|\u0001}',
      ], { embedded: true }),
    ],
    ['renamed.doc', await makeDocx(MINUTES)],
    ['rtf.doc', '{\\rtf1\\ansi hello}'],
    ['word6.doc', word6()],
    ['scan.pdf', await makeScannedTextPdf([['Scanned page one', 'Invoice 2026-11'], ['Scanned page two']])],
    ['mixed.pdf', await makeScannedTextPdf([['Only this page is scanned']], [Array.from({ length: 4 }, () => 'This page has a real text layer.')])],
    ['many.pdf', await makeScannedTextPdf(Array.from({ length: 13 }, (_, i) => [`Page ${i + 1}`]))],
    ['text.pdf', await makePdf([['A text page with plenty of characters', 'on it, well over the limit for little text.']])],
  ];
  for (const [name, data] of files) await writeFile(f(name), data);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('.xls (Excel 97-2003)', () => {
  it('reads cells of every kind with Excel row numbers, dates, formulas and strings across CONTINUE', async () => {
    const r = await extractFile(f('stock.xls'));
    expect(r.meta.kind).toBe('xlsx');
    expect(r.text).toContain('Excel 97-2003 workbook, 3 sheets: 1 "库存" (A1:D8); 2 "Notes" (A1:A1); 3 "hidden one" (empty).');
    expect(r.text).toContain('1\t物料\t数量\t入库日期');
    expect(r.text).toContain('2\t六角螺栓 M8\t120\t2026-11-09');
    expect(r.text).toContain('3\tWasher\t2.5\t2026-11-10 12:00');
    expect(r.text).toContain('4\t7\t8\t9');
    expect(r.text).toContain('5\t\t129.5\t合计');
    expect(r.text).toContain('6\tTRUE\t#DIV/0!\t25%');
    expect(r.text).toContain('7\told label 旧');
    expect(r.text).toContain('8\t\t\t\t示例供应商的一条很长的备注文字');
    expect(r.text).toContain('=== sheet 3 "hidden one" (hidden)');
  });

  it('picks a sheet and a row range like .xlsx', async () => {
    const r = await extractFile(f('stock.xls'), { sheet: 'notes' });
    expect(r.text).toContain('1\tsecond sheet');
    expect(r.text).not.toContain('六角螺栓');
    expect(r.meta.read.sheet).toBe('Notes');
    const w = await extractFile(f('long.xls'), { offset: 20, limit: 5 });
    expect(w.text).toContain('20\t20');
    expect(w.text).toContain('24\t24');
    expect(w.text).not.toContain('25\t25');
    expect(w.meta.read.rows).toBe('20-24');
    await expect(extractFile(f('stock.xls'), { sheet: '9' })).rejects.toThrow('No sheet "9"');
  });

  it('reads an .xlsx or a text table saved under the old name', async () => {
    expect((await extractFile(f('renamed.xls'))).text).toContain('Excel workbook');
    expect((await extractFile(f('table.xls'))).text).toContain('螺栓');
  });

  it('decodes RK numbers', () => {
    expect(rkValue(((123 << 2) | 2) >>> 0)).toBe(123);
    expect(rkValue(((1234 << 2) | 3) >>> 0)).toBe(12.34);
  });
});

describe('.doc (Word 97-2003)', () => {
  it('reads paragraphs and tables as numbered blocks, fields as their result', async () => {
    const r = await extractFile(f('minutes.doc'));
    expect(r.meta.kind).toBe('docx');
    expect(r.text).toContain('Word 97-2003 document: 5 paragraphs and 1 table (6 numbered blocks). It holds 1 picture or embedded object, which are not read.');
    expect(r.text).toContain('[1] 周例会纪要');
    expect(r.text).toContain('[3] Page 3 of the notes');
    expect(r.text).toContain('[4] Table 1 (3 rows × 2 columns):');
    expect(r.text).toContain('| 报价单 第二行 | ALEX.CHEN |');
    expect(r.text).toContain('|  | 空格 |');
    expect(r.text).toContain('[5] 会后补充一行。');
    expect(r.text).toContain('[6] Chart:');
  });

  it('pages with offset/limit like .docx', async () => {
    const r = await extractFile(f('minutes.doc'), { offset: 2, limit: 2 });
    expect(r.text).toContain('Showing blocks 2-3 of 6.');
    expect(r.text).not.toContain('周例会纪要');
  });

  it('reads a .docx under the old name, and says what an RTF file is', async () => {
    expect((await extractFile(f('renamed.doc'))).text).toContain('一、会议信息');
    await expect(extractFile(f('rtf.doc'))).rejects.toThrow('RTF');
    await expect(extractFile(f('word6.doc'))).rejects.toThrow('Word 6.0/95');
  });
});

describe('scanned PDF pages as pictures', () => {
  it('draws pages without a text layer when asked, and says so', async () => {
    const r = await extractFile(f('scan.pdf'), { pageImages: 10 });
    expect(r.text).toContain('Pages with little or no text (probably scanned): 1-2.');
    expect(r.text).not.toContain('follow');
    expect(r.pageImages?.map((p) => p.page)).toEqual([1, 2]);
    const p = r.pageImages![0]!;
    expect(Math.max(p.width, p.height)).toBe(1568);
    expect(p.rgba.length).toBe(p.width * p.height * 4);
    // dark pixels where the text was drawn
    let dark = 0;
    for (let i = 0; i < p.rgba.length; i += 4) if (p.rgba[i]! < 100) dark++;
    expect(dark).toBeGreaterThan(50);
  });

  it('keeps text pages as text and draws only the scanned one', async () => {
    const r = await extractFile(f('mixed.pdf'), { pageImages: 10 });
    expect(r.text).toContain('This page has a real text layer.');
    expect(r.pageImages?.map((p) => p.page)).toEqual([1]);
    expect((await extractFile(f('text.pdf'), { pageImages: 10 })).pageImages).toBeUndefined();
  });

  it('draws at most the number asked for and names the next pages to ask for', async () => {
    const r = await extractFile(f('many.pdf'), { pageImages: 10 });
    expect(r.pageImages).toHaveLength(10);
    expect(r.text).toContain('Not drawn (at most 10 pictures per call): pages 11-13. Call read_file again with pages="11-13" to see them.');
    expect(r.truncated).toBe(true);
    const next = await extractFile(f('many.pdf'), { pageImages: 10, pages: '11-13' });
    expect(next.pageImages?.map((p) => p.page)).toEqual([11, 12, 13]);
  });

  it('says the model cannot see them when it takes no pictures, and draws nothing unless asked', async () => {
    const r = await extractFile(f('scan.pdf'), { pageImages: 0 });
    expect(r.text).toContain('The current model does not take images');
    expect(r.pageImages).toBeUndefined();
    const plain = await extractFile(f('scan.pdf'));
    expect(plain.text).toContain('no text layer on any page');
    expect(plain.pageImages).toBeUndefined();
  });
});
