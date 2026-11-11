// The Excel half: real .xlsx files (made with the bundled ExcelJS) drawn as styled tables;
// files whose pictures ExcelJS cannot read still show their tables. node:test, nothing but
// this plugin's own files: `node --test` in the plugin folder (check.mjs does that) runs it.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

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
    assert.deepEqual(notes, []);
    const sheets = Sheet.visibleSheets(wb);
    assert.deepEqual(sheets.map((s) => s.name), ['报表']); // the hidden sheet is left out
    const { html } = Sheet.renderSheet(sheets[0], wb);
    assert.match(html, /<td colspan="3" style="[^"]*font-weight:700[^"]*color:#ffffff[^"]*background:#1f4e79[^"]*text-align:center[^"]*vertical-align:middle[^"]*">季度汇总<\/td>/);
    assert.ok(html.includes('<tr style="height:32px">')); // 24 pt
    assert.ok(html.includes('<col style="width:145px">')); // width 20
    assert.ok(html.includes('>1,234.50</td>'));
    assert.ok(html.includes('>12.5%</td>'));
    assert.ok(html.includes('>2026-11-11</td>'));
    assert.match(html, /font-style:italic[^"]*color:#ff0000[^"]*border-top:1px solid #000000[^"]*border-bottom:2px solid #000[^"]*">红色斜体</);
    assert.ok(html.includes('>2469</td>')); // a formula shows its result
  });

  it('places pictures over the sheet', async () => {
    const { wb } = await Sheet.loadWorkbook(ExcelJS, JSZip, await sample({ picture: true }));
    const { html } = Sheet.renderSheet(Sheet.visibleSheets(wb)[0], wb);
    assert.match(html, /<img class="pic" alt="" src="data:image\/png;base64,iVBOR[^"]*" style="left:\d+px;top:\d+px;width:50px;height:30px">/);
  });

  it('a file whose pictures cannot be read still shows its table, and says so', async () => {
    // make the drawing unreadable for ExcelJS (it trips over the anchors, as with some files written by other tools)
    const zip = await JSZip.loadAsync(await sample({ picture: true }));
    const name = Object.keys(zip.files).find((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n));
    zip.file(name, (await zip.file(name).async('string')).replace(/xdr:/g, ''));
    const broken = await zip.generateAsync({ type: 'uint8array' });
    await assert.rejects(new ExcelJS.Workbook().xlsx.load(broken));
    const { wb, notes } = await Sheet.loadWorkbook(ExcelJS, JSZip, broken);
    assert.deepEqual(notes, ['这个文件里的图片读不出来，没有显示；表格照常显示。']);
    assert.ok(Sheet.renderSheet(Sheet.visibleSheets(wb)[0], wb).html.includes('>季度汇总</td>'));
  });

  it('a file that is not a workbook is an error (Spica then uses its own preview)', async () => {
    await assert.rejects(Sheet.loadWorkbook(ExcelJS, JSZip, new TextEncoder().encode('not a zip')));
  });

  it('a big sheet shows its first rows and columns and says so', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('big');
    ws.getCell(30, 12).value = 'far';
    const out = Sheet.renderSheet(ws, wb, { rows: 10, cols: 5 });
    assert.deepEqual(out.notes, ['只显示前 10 行。', '只显示前 5 列。']);
    assert.ok(!out.html.includes('far'));
  });

  it('number formats: the common ones', () => {
    assert.equal(Sheet.formatValue(1234567.891, '#,##0'), '1,234,568');
    assert.equal(Sheet.formatValue(-42.5, '0.00'), '-42.50');
    assert.equal(Sheet.formatValue(0.5, '0%'), '50%');
    assert.equal(Sheet.formatValue(12.3456, 'General'), '12.3456');
    assert.equal(Sheet.formatValue(9.99, '"¥"#,##0.00'), '¥9.99');
    assert.equal(Sheet.formatValue({ richText: [{ text: '甲' }, { text: '乙' }] }), '甲乙');
    assert.equal(Sheet.formatValue({ text: '链接', hyperlink: 'https://example.com' }), '链接');
    assert.equal(Sheet.formatValue(true), 'TRUE');
    assert.equal(Sheet.color({ argb: '00ABCDEF' }), '#abcdef');
  });
});
