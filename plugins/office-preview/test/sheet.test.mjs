// The Excel half: real .xlsx files (made with the bundled ExcelJS) drawn as styled tables;
// files whose pictures ExcelJS cannot read still show their tables. Also: the plugin passes
// Spica's checks for its declarations.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readPluginFolder } from '../../../packages/plugins/src/folder.ts';

const require = createRequire(import.meta.url);
const ExcelJS = require('../ui/vendor/exceljs.bare.min.js');
const JSZip = require('../ui/vendor/jszip.min.js');
const Sheet = require('../ui/sheet.js');

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function sample({ picture = false } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('报表');
  ws.mergeCells('A1:C1');
  ws.getCell('A1').value = '季度汇总';
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  ws.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 14 };
  ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 24;
  ws.getCell('A2').value = 1234.5;
  ws.getCell('A2').numFmt = '#,##0.00';
  ws.getCell('B2').value = 0.125;
  ws.getCell('B2').numFmt = '0.0%';
  ws.getCell('C2').value = new Date(Date.UTC(2026, 10, 11));
  ws.getCell('C2').numFmt = 'yyyy-mm-dd';
  ws.getCell('A3').value = '红色斜体';
  ws.getCell('A3').font = { italic: true, color: { argb: '00FF0000' } }; // alpha 00, as openpyxl writes it
  ws.getCell('A3').border = { top: { style: 'thin', color: { argb: 'FF000000' } }, bottom: { style: 'medium' } };
  ws.getCell('B3').value = { formula: 'A2*2', result: 2469 };
  ws.getColumn(1).width = 20;
  wb.addWorksheet('隐藏', { state: 'hidden' }).getCell('A1').value = 'x';
  if (picture) {
    const id = wb.addImage({ buffer: PNG_1X1, extension: 'png' });
    ws.addImage(id, { tl: { col: 1, row: 3 }, ext: { width: 50, height: 30 } });
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('Excel workbook to a styled table', () => {
  it('keeps fills, font colour and style, merges, widths, heights, borders and number formats', async () => {
    const { wb, notes } = await Sheet.loadWorkbook(ExcelJS, JSZip, await sample());
    expect(notes).toEqual([]);
    const sheets = Sheet.visibleSheets(wb);
    expect(sheets.map((s) => s.name)).toEqual(['报表']); // the hidden sheet is left out
    const { html } = Sheet.renderSheet(sheets[0], wb);
    expect(html).toMatch(/<td colspan="3" style="[^"]*font-weight:700[^"]*color:#ffffff[^"]*background:#1f4e79[^"]*text-align:center[^"]*vertical-align:middle[^"]*">季度汇总<\/td>/);
    expect(html).toContain('<tr style="height:32px">'); // 24 pt
    expect(html).toContain('<col style="width:145px">'); // width 20
    expect(html).toContain('>1,234.50</td>');
    expect(html).toContain('>12.5%</td>');
    expect(html).toContain('>2026-11-11</td>');
    expect(html).toMatch(/font-style:italic[^"]*color:#ff0000[^"]*border-top:1px solid #000000[^"]*border-bottom:2px solid #000[^"]*">红色斜体</);
    expect(html).toContain('>2469</td>'); // a formula shows its result
    expect(html).not.toMatch(/<td[^>]*>[^<]*<script/);
  });

  it('places pictures over the sheet', async () => {
    const { wb } = await Sheet.loadWorkbook(ExcelJS, JSZip, await sample({ picture: true }));
    const { html } = Sheet.renderSheet(Sheet.visibleSheets(wb)[0], wb);
    expect(html).toMatch(/<img class="pic" alt="" src="data:image\/png;base64,iVBOR[^"]*" style="left:\d+px;top:\d+px;width:50px;height:30px">/);
  });

  it('a file whose pictures cannot be read still shows its table, and says so', async () => {
    // make the drawing unreadable for ExcelJS (it trips over the anchors, as with some files written by other tools)
    const zip = await JSZip.loadAsync(await sample({ picture: true }));
    const name = Object.keys(zip.files).find((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n));
    zip.file(name, (await zip.file(name).async('string')).replace(/xdr:/g, ''));
    const broken = await zip.generateAsync({ type: 'uint8array' });
    await expect(new ExcelJS.Workbook().xlsx.load(broken)).rejects.toThrow();
    const { wb, notes } = await Sheet.loadWorkbook(ExcelJS, JSZip, broken);
    expect(notes).toEqual(['这个文件里的图片读不出来，没有显示；表格照常显示。']);
    expect(Sheet.renderSheet(Sheet.visibleSheets(wb)[0], wb).html).toContain('>季度汇总</td>');
  });

  it('a file that is not a workbook is an error (Spica then uses its own preview)', async () => {
    await expect(Sheet.loadWorkbook(ExcelJS, JSZip, new TextEncoder().encode('not a zip'))).rejects.toThrow();
  });

  it('a big sheet shows its first rows and columns and says so', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('big');
    ws.getCell(30, 12).value = 'far';
    const out = Sheet.renderSheet(ws, wb, { rows: 10, cols: 5 });
    expect(out.notes).toEqual(['只显示前 10 行。', '只显示前 5 列。']);
    expect(out.html).not.toContain('far');
  });

  it('number formats: the common ones', () => {
    expect(Sheet.formatValue(1234567.891, '#,##0')).toBe('1,234,568');
    expect(Sheet.formatValue(-42.5, '0.00')).toBe('-42.50');
    expect(Sheet.formatValue(0.5, '0%')).toBe('50%');
    expect(Sheet.formatValue(12.3456, 'General')).toBe('12.3456');
    expect(Sheet.formatValue(9.99, '"¥"#,##0.00')).toBe('¥9.99');
    expect(Sheet.formatValue({ richText: [{ text: '甲' }, { text: '乙' }] })).toBe('甲乙');
    expect(Sheet.formatValue({ text: '链接', hyperlink: 'https://example.com' })).toBe('链接');
    expect(Sheet.formatValue(true)).toBe('TRUE');
    expect(Sheet.color({ argb: '00ABCDEF' })).toBe('#abcdef');
  });
});

describe('the plugin itself', () => {
  it('passes the plugin checks: two preview pages, no tools', async () => {
    const folder = await readPluginFolder(fileURLToPath(new URL('..', import.meta.url)));
    expect(folder.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(folder.views.map((v) => [v.id, v.placement, v.preview?.extensions, v.tools])).toEqual([
      ['docx', 'preview', ['.docx', '.docm'], undefined],
      ['xlsx', 'preview', ['.xlsx', '.xlsm'], undefined],
    ]);
  });
});
