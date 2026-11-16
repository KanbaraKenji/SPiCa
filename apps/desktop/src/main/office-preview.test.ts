import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeDocx, makeInventoryXlsx } from '../../../../packages/extract/src/testing/fixtures';
import { docxMarkdown, sheetGrid } from './office-preview';
import { PreviewFiles, readPreview } from './preview';

describe('Word and Excel in the right panel', () => {
  it('a Word document as Markdown: headings, paragraphs, list items together, tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-office-'));
    const path = join(dir, '评审纪要.docx');
    writeFileSync(
      path,
      await makeDocx({
        title: '样机评审纪要',
        sections: [{ heading: '结论', paragraphs: ['外壳尺寸定为 120×80×24 mm。'], bullets: ['续航达标', '月底交付'], table: [['供应商', '单价'], ['华东精密', '128.50']] }],
      }),
    );
    const info = await readPreview(path, new PreviewFiles());
    expect(info.kind).toBe('markdown');
    const text = info.kind === 'markdown' ? info.text : '';
    expect(text).toContain('样机评审纪要');
    expect(text).toContain('外壳尺寸定为 120×80×24 mm。');
    expect(text).toMatch(/续航达标\n.*月底交付/);
    expect(text).toMatch(/\| 供应商 \| 单价 \|/);
    expect(text).not.toMatch(/^\[\d+\]/m);
  });

  it('a Word document cut short says how many of its paragraphs show: past 500 of them, or at the size limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-office-'));
    // 1 351 short paragraphs: the 500 stop, not the size limit.
    writeFileSync(join(dir, '长.docx'), await makeDocx({ title: '汇编', sections: Array.from({ length: 150 }, (_, s) => ({ heading: `第 ${s + 1} 章`, paragraphs: Array.from({ length: 8 }, (_, k) => `第 ${k + 1} 段`) })) }));
    expect(await readPreview(join(dir, '长.docx'), new PreviewFiles())).toMatchObject({ truncated: true, blocks: { shown: 500, total: 1351 } });
    // 133 long paragraphs: the size limit stops it well before 500.
    const long = '较长的示例正文，用来把文档撑到字数上限。'.repeat(25);
    writeFileSync(join(dir, '密.docx'), await makeDocx({ title: '说明', sections: Array.from({ length: 12 }, (_, s) => ({ heading: `第 ${s + 1} 节`, paragraphs: Array.from({ length: 10 }, () => long) })) }));
    const dense = await readPreview(join(dir, '密.docx'), new PreviewFiles());
    expect(dense).toMatchObject({ truncated: true, blocks: { total: 133 } });
    expect(dense.kind === 'markdown' ? dense.blocks!.shown : 0).toBeLessThan(133);
    // A short one: nothing said.
    writeFileSync(join(dir, '短.docx'), await makeDocx({ title: '短', sections: [{ heading: '一', paragraphs: ['正文'] }] }));
    expect(await readPreview(join(dir, '短.docx'), new PreviewFiles())).not.toHaveProperty('blocks');
  });

  it('an Excel workbook: the sheet asked for as a grid with column letters and row numbers, and every sheet’s name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-office-'));
    const path = join(dir, '库存.xlsx');
    writeFileSync(path, await makeInventoryXlsx());
    const files = new PreviewFiles();
    const first = await readPreview(path, files);
    expect(first.kind).toBe('sheet');
    if (first.kind !== 'sheet') return;
    expect(first.sheets.map((s) => s.name)).toEqual(['库存', '进货记录', '空白页', '说明']);
    expect(first.sheet).toBe(1);
    expect(first.columns.slice(0, 3)).toEqual(['A', 'B', 'C']);
    expect(first.rows[0]).toMatchObject({ n: 1 });
    expect(first.rows[0]!.cells[0]).toBe('品名');
    expect(first.rows.some((r) => r.cells[0] === '便携显示器')).toBe(true);
    expect(first.truncated).toBe(false);
    const second = await readPreview(path, files, 2);
    expect(second.kind === 'sheet' ? [second.sheet, second.rows[0]?.cells[1]] : []).toEqual([2, '供应商']);
  });

  it('a long sheet stops at 500 rows and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-office-'));
    const path = join(dir, '库存.xlsx');
    writeFileSync(path, await makeInventoryXlsx(800));
    const info = await readPreview(path, new PreviewFiles());
    expect(info.kind === 'sheet' ? [info.rows.length, info.truncated] : []).toEqual([500, true]);
  });

  it('reads the extractor’s layout', () => {
    expect(docxMarkdown('Word document\n\n[1] # 标题\n[2] 正文\n[3] - 一\n[4] - 二\n[5] Table 1 (2×2):\n    | a | b |\n    | 1 | 2 |')).toBe('# 标题\n\n正文\n\n- 一\n- 二\n\n| a | b |\n| 1 | 2 |');
    expect(sheetGrid('Sheet "库存"\nrow\tA\tB\n(header) 1\t品名\t数量\n2\t键盘\t150\n\nmore')).toEqual({ columns: ['A', 'B'], rows: [{ n: 1, cells: ['品名', '数量'] }, { n: 2, cells: ['键盘', '150'] }] });
    expect(sheetGrid('nothing')).toEqual({ columns: [], rows: [] });
  });
});
