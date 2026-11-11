import { describe, expect, it } from 'vitest';
import { fullPath, localPathKind } from './local-path';

describe('paths in an answer that open', () => {
  it('inline code that is exactly an absolute path: a file, or a folder when it ends with a separator', () => {
    expect(localPathKind('D:\\工作\\样机评审\\报价汇总.xlsx')).toBe('file');
    expect(localPathKind('D:\\工作\\样机评审\\报价\\')).toBe('folder');
    expect(localPathKind('D:/工作/样机评审/chart 1.png')).toBe('file');
    expect(localPathKind('D:/工作/')).toBe('folder');
    expect(localPathKind('D:\\')).toBe('folder');
    expect(localPathKind('\\\\server\\share\\报价.xlsx')).toBe('file');
    expect(localPathKind('\\\\server\\share')).toBe('folder');
    expect(localPathKind('\\\\server\\share\\')).toBe('folder');
  });

  it('anything else stays plain code', () => {
    for (const code of ['单价', '报价汇总.xlsx', '.\\报价', 'src/main.ts', '/usr/bin/env', 'D:', 'D:工作', ' D:\\a.txt', 'D:\\a.txt ', 'D:\\a?.txt', 'D:\\a\nb', 'https://example.com/a', 'C:\\a.txt and C:\\b.txt:2', '\\\\server'])
      expect(localPathKind(code), code).toBeNull();
  });
});

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
