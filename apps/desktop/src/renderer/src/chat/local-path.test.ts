import { describe, expect, it } from 'vitest';
import { fullPath } from './local-path';

describe('a path made absolute', () => {
  it('keeps an absolute one', () => {
    expect(fullPath('D:\\工作\\a.xlsx', 'C:\\x')).toBe('D:\\工作\\a.xlsx');
    expect(fullPath('\\\\server\\share\\a.xlsx')).toBe('\\\\server\\share\\a.xlsx');
  });

  it('puts the working folder in front of a relative one', () => {
    expect(fullPath('需求说明.docx', 'D:\\工作\\样机评审')).toBe('D:\\工作\\样机评审\\需求说明.docx');
    expect(fullPath('out/表.csv', 'D:\\工作\\样机评审\\')).toBe('D:\\工作\\样机评审\\out\\表.csv');
    expect(fullPath('..\\报价\\a.xlsx', 'D:\\工作\\样机评审')).toBe('D:\\工作\\报价\\a.xlsx');
    expect(fullPath('./a.txt', '/home/u/w')).toBe('/home/u/w/a.txt');
  });

  it('resolves . and .. in an absolute one', () => {
    expect(fullPath('D:\\工作\\.\\a\\..\\b.txt')).toBe('D:\\工作\\b.txt');
  });

  it('leaves a relative one as it is without a folder', () => {
    expect(fullPath('a.txt')).toBe('a.txt');
    expect(fullPath('a.txt', '')).toBe('a.txt');
  });
});
