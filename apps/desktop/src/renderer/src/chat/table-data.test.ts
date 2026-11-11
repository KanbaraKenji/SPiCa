// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { tableRows, toCsv, toHtml, toTsv } from './table-data';

const rows = [
  ['供应商', '单价（元）', '备注'],
  ['华东精密', '128.50', '含税, 不含运费'],
  ['启明 "电子"', '131.00', '两行\n备注'],
];

describe('a table as data', () => {
  it('reads the cells, header first, with spaces made single', () => {
    const t = document.createElement('table');
    t.innerHTML = '<thead><tr><th>供应商</th><th>单价</th></tr></thead><tbody><tr><td> 华东  <b>精密</b> </td><td>128.50</td></tr></tbody>';
    expect(tableRows(t)).toEqual([
      ['供应商', '单价'],
      ['华东 精密', '128.50'],
    ]);
  });

  it('copies as tab-separated lines; a cell with a quote or line break is quoted', () => {
    expect(toTsv(rows)).toBe('供应商\t单价（元）\t备注\r\n华东精密\t128.50\t含税, 不含运费\r\n"启明 ""电子"""\t131.00\t"两行\n备注"');
  });

  it('exports CSV: commas, quotes and line breaks quoted, CRLF lines', () => {
    expect(toCsv(rows)).toBe('供应商,单价（元）,备注\r\n华东精密,128.50,"含税, 不含运费"\r\n"启明 ""电子""",131.00,"两行\n备注"\r\n');
  });

  it('copies a plain HTML table too, so it pastes into Excel as cells', () => {
    expect(toHtml([['a<b', '"c"'], ['1 & 2', '3']])).toBe('<table><thead><tr><th>a&lt;b</th><th>&quot;c&quot;</th></tr></thead><tbody><tr><td>1 &amp; 2</td><td>3</td></tr></tbody></table>');
  });
});
