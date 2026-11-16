// The libraries the Agent's scripts can require: bundled into one file each, they work under the app's Electron
// running as Node (ELECTRON_RUN_AS_NODE) found through NODE_PATH alone, with no node_modules next to the script.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { NODE_LIBS, buildNodeLibs } from './node-libs.mjs';

vi.setConfig({ testTimeout: 120_000 });
const dir = mkdtempSync(join(tmpdir(), 'spica-node-libs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('node-libs', () => {
  it('each library is one file with its package.json and licence', async () => {
    const out = join(dir, 'libs');
    const w = await buildNodeLibs(out);
    expect(w.map((x) => x.name)).toEqual(NODE_LIBS);
    for (const name of NODE_LIBS) {
      const pkg = JSON.parse(readFileSync(join(out, name, 'package.json'), 'utf8'));
      expect(pkg).toMatchObject({ name, main: 'index.js', license: 'MIT' });
      expect(readFileSync(join(out, name, 'LICENSE'), 'utf8')).toMatch(/MIT|Permission is hereby granted/);
    }
    // exceljs's dependencies are listed with their licences; uuid is the fixed one, not the 8.x exceljs asks for
    const third = readFileSync(join(out, 'exceljs', 'THIRD-PARTY.txt'), 'utf8');
    expect(third).toMatch(/^jszip 3\.10\.2 /m);
    expect(third).toMatch(/^uuid 14\.\d+\.\d+ \(MIT\)/m);
    expect(third).not.toMatch(/^uuid 8\./m);
  });

  it('a script far from any node_modules reads and writes .xlsx and CSV through NODE_PATH, on Electron as Node', async () => {
    let electron;
    try {
      electron = createRequire(join(import.meta.dirname, '..', 'package.json'))('electron');
    } catch {
      return; // electron is not installed here
    }
    const out = join(dir, 'libs');
    await buildNodeLibs(out);
    const work = mkdtempSync(join(tmpdir(), 'spica-node-libs-run-'));
    try {
      writeFileSync(join(work, 'in.csv'), Buffer.concat([Buffer.from('store,amount\n'), Buffer.from([0xbc, 0xd7]) /* 甲 in GBK */, Buffer.from(',"1,5"\n')]));
      writeFileSync(
        join(work, 'go.js'),
        `const ExcelJS = require('exceljs'); const Papa = require('papaparse'); const fs = require('fs');
(async () => {
  const text = new TextDecoder('gbk').decode(fs.readFileSync('in.csv'));
  const rows = Papa.parse(text, { header: true, skipEmptyLines: true }).data;
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('汇总');
  ws.addRow(['门店', '金额']); for (const r of rows) ws.addRow([r.store, Number(r.amount.replace(',', '.'))]);
  ws.addConditionalFormatting({ ref: 'B2:B2', rules: [{ type: 'dataBar', priority: 1, cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF638EC6' } }] });
  await wb.xlsx.writeFile('out.xlsx');
  const back = new ExcelJS.Workbook(); await back.xlsx.readFile('out.xlsx');
  console.log(JSON.stringify(back.getWorksheet('汇总').getRow(2).values.slice(1)), Papa.unparse(rows));
})().catch((e) => { console.error(e); process.exit(1); });`,
      );
      const stdout = execFileSync(electron, ['go.js'], {
        cwd: work,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: out },
      });
      expect(stdout).toContain('["甲",1.5]');
      expect(stdout).toContain('store,amount');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
