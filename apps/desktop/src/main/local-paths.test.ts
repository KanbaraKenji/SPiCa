import { describe, expect, it } from 'vitest';
import { checkLocalPath, csvFileName, csvFileText, type PathKind } from './local-paths';

const disk: Record<string, PathKind> = { 'D:\\工作\\报价汇总.xlsx': 'file', 'D:\\工作\\报价\\': 'folder', 'D:\\工作': 'folder' };
const kindOf = (p: string) => disk[p] ?? null;

describe('paths the page hands to Explorer', () => {
  it('a file or a folder that is there is shown in its folder', () => {
    expect(checkLocalPath('D:\\工作\\报价汇总.xlsx', 'any', kindOf)).toEqual({ ok: true, path: 'D:\\工作\\报价汇总.xlsx' });
    expect(checkLocalPath('D:\\工作', 'any', kindOf)).toEqual({ ok: true, path: 'D:\\工作' });
  });

  it('only a folder is opened as a folder', () => {
    expect(checkLocalPath('D:\\工作\\报价\\', 'folder', kindOf)).toEqual({ ok: true, path: 'D:\\工作\\报价\\' });
    expect(checkLocalPath('D:\\工作\\报价汇总.xlsx', 'folder', kindOf)).toEqual({ ok: false, error: '找不到文件夹：D:\\工作\\报价汇总.xlsx' });
  });

  it('says what is missing', () => {
    expect(checkLocalPath('D:\\工作\\没有.pdf', 'any', kindOf)).toEqual({ ok: false, error: '找不到文件：D:\\工作\\没有.pdf' });
    expect(checkLocalPath('D:\\没有\\', 'folder', kindOf)).toEqual({ ok: false, error: '找不到文件夹：D:\\没有\\' });
  });

  it('refuses what is not an absolute path, without looking', () => {
    let looked = 0;
    const count = (p: string) => {
      looked++;
      return kindOf(p);
    };
    for (const p of ['报价汇总.xlsx', '.\\a', '', 42, null, 'D:'.padEnd(5000, 'x')]) expect(checkLocalPath(p, 'any', count)).toEqual({ ok: false, error: '路径无效。' });
    expect(looked).toBe(0);
  });
});

describe('CSV export', () => {
  it('suggests a safe name ending in .csv', () => {
    expect(csvFileName('报价汇总')).toBe('报价汇总.csv');
    expect(csvFileName('a/b:c*?.CSV')).toBe('abc.csv');
    expect(csvFileName('')).toBe('表格.csv');
    expect(csvFileName('报价\n汇总\t')).toBe('报价汇总.csv');
    expect(csvFileName(undefined)).toBe('表格.csv');
  });

  it('starts the file with a byte-order mark once', () => {
    expect(csvFileText('供应商,单价\r\n')).toBe('\uFEFF供应商,单价\r\n');
    expect(csvFileText('\uFEFFa')).toBe('\uFEFFa');
  });
});
