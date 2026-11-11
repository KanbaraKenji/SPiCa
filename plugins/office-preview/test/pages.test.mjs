// @vitest-environment jsdom
/* global window, document */
// The pages as Spica runs them: the page's own scripts, a stand-in for Spica's bridge
// (window.spica.preview), a Word file made here. Drawn -> ready(); not a Word file -> fail().
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const JSZip = require('../ui/vendor/jszip.min.js');
const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const ui = (name) => readFileSync(join(UI, name), 'utf8');

/** A .docx with one paragraph: bold red text. */
async function wordFile() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t>季度汇报</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>');
  return zip.generateAsync({ type: 'arraybuffer' });
}

/** Load the docx page's scripts with a stand-in bridge handing over `bytes`; resolves with what the page told it. */
async function openWordPage(bytes) {
  document.body.innerHTML = '<div id="status" class="status"></div><div id="doc"></div>';
  const told = [];
  let done;
  const finished = new Promise((r) => (done = r));
  window.spica = {
    onEvent: () => () => {},
    preview: {
      file: async () => ({ name: 'q.docx', size: bytes.byteLength, modifiedAt: '2026-11-11T10:00:00+08:00', extension: '.docx', bytes }),
      ready: () => (told.push('ready'), done()),
      fail: (m) => (told.push(`fail: ${m}`), done()),
    },
  };
  window.JSZip = JSZip;
  for (const f of ['vendor/docx-preview.min.js', 'common.js', 'docx.js']) window.eval(ui(f));
  await finished;
  return told;
}

describe('the Word page', () => {
  it('draws the file and says it is ready', async () => {
    const told = await openWordPage(await wordFile());
    expect(told).toEqual(['ready']);
    const doc = document.getElementById('doc');
    expect(doc.textContent).toContain('季度汇报');
    expect(doc.innerHTML).toMatch(/font-weight:\s*bold|<b>|font-weight: 700/);
    expect(doc.innerHTML.toLowerCase()).toMatch(/color:\s*(#ff0000|rgb\(255, 0, 0\))/);
    expect(document.getElementById('status').hidden).toBe(true);
  });

  it('a file that is not a Word document: fail() with a sentence, nothing else', async () => {
    const told = await openWordPage(new TextEncoder().encode('not a zip').buffer);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/^fail: 这个 Word 文件打不开：/);
  });
});

describe('the Excel page', () => {
  it('one tab per sheet, the first one drawn, then ready()', async () => {
    const ExcelJS = require('../ui/vendor/exceljs.bare.min.js');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('一月').getCell('A1').value = '收入';
    wb.addWorksheet('二月').getCell('A1').value = '支出';
    const bytes = (await wb.xlsx.writeBuffer()).buffer;
    document.body.innerHTML = '<div id="status" class="status"></div><div id="doc"></div>';
    const told = [];
    let done;
    const finished = new Promise((r) => (done = r));
    window.spica = {
      onEvent: () => () => {},
      preview: {
        file: async () => ({ name: 'q.xlsx', size: 1, modifiedAt: '2026-11-11T10:00:00+08:00', extension: '.xlsx', bytes }),
        ready: () => (told.push('ready'), done()),
        fail: (m) => (told.push(`fail: ${m}`), done()),
      },
    };
    window.JSZip = JSZip;
    for (const f of ['vendor/exceljs.bare.min.js', 'sheet.js', 'common.js', 'xlsx.js']) window.eval(ui(f));
    await finished;
    expect(told).toEqual(['ready']);
    const tabs = [...document.querySelectorAll('.tabs button')];
    expect(tabs.map((b) => [b.textContent, b.getAttribute('aria-selected')])).toEqual([
      ['一月', 'true'],
      ['二月', 'false'],
    ]);
    expect(document.querySelector('.view').textContent).toContain('收入');
    tabs[1].click();
    expect(document.querySelector('.view').textContent).toContain('支出');
  });
});
