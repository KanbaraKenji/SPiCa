// @vitest-environment jsdom
/* global window, document */
// The official plugin office-preview: its pages as Spica runs them (the page's own scripts,
// a stand-in for Spica's bridge window.spica.preview, files made here), its declarations, and
// the author kit's full self-check (check.mjs, its own node:test tests included).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { readPluginFolder } from './folder.ts';

vi.setConfig({ testTimeout: 60_000 });

// a plain path (in the jsdom environment the global URL is not the one node:url takes)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLUGIN = join(REPO, 'plugins', 'office-preview');
const UI = join(PLUGIN, 'ui');
const require = createRequire(import.meta.url);
const JSZip = require(join(UI, 'vendor', 'jszip.min.js'));
const ui = (name) => readFileSync(join(UI, name), 'utf8');

/** Load a page's scripts with a stand-in bridge handing over `bytes`; resolves with what the page told it. */
async function openPage(scripts, name, bytes) {
  document.body.innerHTML = '<div id="status" class="status"></div><div id="doc"></div>';
  const told = [];
  let done;
  const finished = new Promise((r) => (done = r));
  window.spica = {
    onEvent: () => () => {},
    preview: {
      file: async () => ({ name, size: bytes.byteLength, modifiedAt: '2026-11-11T10:00:00+08:00', extension: name.slice(name.lastIndexOf('.')), bytes }),
      ready: () => (told.push('ready'), done()),
      fail: (m) => (told.push(`fail: ${m}`), done()),
    },
  };
  window.JSZip = JSZip;
  for (const f of scripts) window.eval(ui(f));
  await finished;
  return told;
}

/** A .docx with one paragraph: bold red text. */
async function wordFile() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t>季度汇报</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>');
  return zip.generateAsync({ type: 'arraybuffer' });
}

const WORD = ['vendor/docx-preview.min.js', 'common.js', 'docx.js'];
const EXCEL = ['vendor/exceljs.bare.min.js', 'sheet.js', 'common.js', 'xlsx.js'];

describe('the Word page', () => {
  it('draws the file and says it is ready', async () => {
    expect(await openPage(WORD, 'q.docx', await wordFile())).toEqual(['ready']);
    const doc = document.getElementById('doc');
    expect(doc.textContent).toContain('季度汇报');
    expect(doc.innerHTML).toMatch(/font-weight:\s*bold|<b>|font-weight: 700/);
    expect(doc.innerHTML.toLowerCase()).toMatch(/color:\s*(#ff0000|rgb\(255, 0, 0\))/);
    expect(document.getElementById('status').hidden).toBe(true);
  });

  it('a file that is not a Word document: fail() with a sentence, nothing else', async () => {
    const told = await openPage(WORD, 'q.docx', new TextEncoder().encode('not a zip').buffer);
    // one short sentence; the library's own (English) wording stays in the console
    expect(told).toEqual(['fail: 这个 Word 文件打不开']);
  });
});

describe('the Excel page', () => {
  it('one tab per sheet, the first one drawn, then ready()', async () => {
    const ExcelJS = require(join(UI, 'vendor', 'exceljs.bare.min.js'));
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('一月').getCell('A1').value = '收入';
    wb.addWorksheet('二月').getCell('A1').value = '支出';
    const bytes = (await wb.xlsx.writeBuffer()).buffer;
    expect(await openPage(EXCEL, 'q.xlsx', bytes)).toEqual(['ready']);
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

describe('the plugin itself', () => {
  it('passes the plugin checks: two preview pages, no tools', async () => {
    const folder = await readPluginFolder(PLUGIN);
    expect(folder.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(folder.views.map((v) => [v.id, v.placement, v.preview?.extensions, v.tools])).toEqual([
      ['docx', 'preview', ['.docx', '.docm'], undefined],
      ['xlsx', 'preview', ['.xlsx', '.xlsm'], undefined],
    ]);
  });

  it("passes the author kit's full self-check, its own tests included", async () => {
    const out = await new Promise((done) => {
      const child = spawn(process.execPath, [join(REPO, 'skills', 'spica-plugin-author', 'scripts', 'check.mjs'), PLUGIN, '--no-pack'], { windowsHide: true });
      let text = '';
      child.stdout.on('data', (b) => (text += b.toString()));
      child.stderr.on('data', (b) => (text += b.toString()));
      child.on('close', (code) => done({ code, text }));
    });
    expect(out.code, out.text).toBe(0);
    expect(out.text).toContain('test/ 里的测试全过');
    expect(out.text).toContain('可以装了');
    expect(out.text).not.toMatch(/^！/m); // no hints either
  });
});
