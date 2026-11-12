import { describe, expect, it } from 'vitest';
import { findPlainPaths, fullPath, insideFolder, localPathKind, openablePathKind, pathLabel } from './local-path';

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

describe('network paths (Windows sends the sign-in to the host when one opens)', () => {
  it('device paths are never paths', () => {
    for (const code of ['\\\\.\\pipe\\x', '\\\\?\\C:\\a.txt', '\\\\.\\C:\\']) expect(localPathKind(code), code).toBeNull();
  });

  it('a \\\\host path opens only inside the working folder', () => {
    const cwd = '\\\\files\\proj\\样机';
    expect(openablePathKind('\\\\files\\proj\\样机\\报价.xlsx', cwd)).toBe('file');
    expect(openablePathKind('\\\\FILES\\Proj\\样机\\out\\', cwd)).toBe('folder');
    expect(openablePathKind('\\\\files\\proj\\样机\\', cwd)).toBe('folder');
    for (const code of ['\\\\evil.example.com\\share\\a.xlsx', '\\\\files\\proj\\样机2\\a.txt', '\\\\files\\proj\\样机\\..\\其他\\a.txt', '\\\\files\\proj\\'])
      expect(openablePathKind(code, cwd), code).toBeNull();
    expect(openablePathKind('\\\\files\\proj\\样机\\报价.xlsx', 'D:\\工作')).toBeNull();
    expect(openablePathKind('\\\\files\\proj\\样机\\报价.xlsx', undefined)).toBeNull();
  });

  it('drive paths open wherever they are (a mapped network drive too)', () => {
    expect(openablePathKind('Z:\\共享\\报价.xlsx', 'D:\\工作')).toBe('file');
    expect(openablePathKind('D:\\工作\\', undefined)).toBe('folder');
  });

  it('inside a folder: case ignored, .. resolved, a sibling with the same start is not inside', () => {
    expect(insideFolder('D:\\工作\\A\\b.txt', 'd:\\工作\\a\\')).toBe(true);
    expect(insideFolder('D:\\工作\\a\\..\\b.txt', 'D:\\工作\\a')).toBe(false);
    expect(insideFolder('D:\\工作\\ab\\c.txt', 'D:\\工作\\a')).toBe(false);
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

describe('what a path in an answer shows', () => {
  it('a file: its name; a folder: its name and the separator after it', () => {
    expect(pathLabel('C:\\Users\\Demo\\AppData\\Local\\Temp\\claude\\6b0a\\scratchpad\\concurrent\\A\\280040440007.pdf')).toBe('280040440007.pdf');
    expect(pathLabel('D:\\工作\\样机评审\\报价\\')).toBe('报价\\');
    expect(pathLabel('D:/工作/报价/')).toBe('报价/');
    expect(pathLabel('\\\\files\\proj\\报价.xlsx')).toBe('报价.xlsx');
  });

  it('a drive or a share on its own shows whole', () => {
    expect(pathLabel('D:\\')).toBe('D:\\');
    expect(pathLabel('\\\\files\\proj')).toBe('\\\\files\\proj');
    expect(pathLabel('\\\\files\\proj\\')).toBe('\\\\files\\proj\\');
  });

  it('the same name in another folder: the folders above until they differ (letters case ignored)', () => {
    const all = ['D:\\样机\\第一版\\报价.xlsx', 'D:\\样机\\第二版\\报价.xlsx', 'D:\\样机\\说明.docx'];
    expect(all.map((p) => pathLabel(p, all))).toEqual(['第一版\\报价.xlsx', '第二版\\报价.xlsx', '说明.docx']);
    expect(pathLabel('D:\\a\\Report.pdf', ['D:\\b\\report.PDF'])).toBe('a\\Report.pdf');
    expect(pathLabel('D:\\样机\\第一版\\', ['E:\\样机\\第二版\\第一版\\'])).toBe('样机\\第一版\\');
  });

  it('paths that differ only in the drive show whole', () => {
    expect(pathLabel('C:\\a\\x.txt', ['D:\\a\\x.txt'])).toBe('C:\\a\\x.txt');
  });

  it('the same path written twice, or once with a separator at the end, is one place', () => {
    expect(pathLabel('D:\\a\\b.txt', ['D:\\a\\b.txt', 'D:\\A\\B.TXT'])).toBe('b.txt');
  });
});

describe('full paths written in plain text', () => {
  const paths = (text: string) => findPlainPaths(text).map((h) => h.path);

  it('a drive or a share, a file with an extension or a folder ending with a separator', () => {
    expect(paths('图纸：C:\\Users\\Demo\\Temp\\A\\280040440007.pdf')).toEqual(['C:\\Users\\Demo\\Temp\\A\\280040440007.pdf']);
    expect(paths('都在 D:\\工作\\样机评审\\报价\\ 里')).toEqual(['D:\\工作\\样机评审\\报价\\']);
    expect(paths('D:/工作/报价.xlsx')).toEqual(['D:/工作/报价.xlsx']);
    expect(paths('共享盘 \\\\files\\proj\\报价.xlsx 上')).toEqual(['\\\\files\\proj\\报价.xlsx']);
    expect(paths('a.tar.gz 在 D:\\a\\b.tar.gz')).toEqual(['D:\\a\\b.tar.gz']);
  });

  it('ends at a space, punctuation or a bracket; a full stop after it is not part of it', () => {
    expect(paths('见 D:\\a\\b.txt。再看 E:\\c\\d.txt，和 F:\\e.txt.')).toEqual(['D:\\a\\b.txt', 'E:\\c\\d.txt', 'F:\\e.txt']);
    expect(paths('（D:\\a\\b.txt）和 "D:\\a\\c.txt" 和 (D:\\a\\d.txt)')).toEqual(['D:\\a\\b.txt', 'D:\\a\\c.txt', 'D:\\a\\d.txt']);
  });

  it('Chinese right after the extension is not part of it', () => {
    expect(paths('放在D:\\工作\\报价.xlsx里了')).toEqual(['D:\\工作\\报价.xlsx']);
    expect(findPlainPaths('放在D:\\a.txt里')[0]).toMatchObject({ start: 2, end: 10 });
    expect(paths('D:\\a.txt和D:\\b.txt')).toEqual(['D:\\a.txt', 'D:\\b.txt']);
  });

  it('left as text when the end is not certain: a space or bracket in a name, no extension, letters after it', () => {
    expect(paths('D:\\My Files\\a.txt')).toEqual([]);
    expect(paths('D:\\a\\My Doc.txt')).toEqual([]);
    expect(paths('D:\\a.b c\\d.txt')).toEqual([]);
    expect(paths('D:\\a\\报价(1).xlsx')).toEqual([]);
    expect(paths('在 D:\\工作\\样机评审 里')).toEqual([]);
    expect(paths('D:\\工作\\样机评审里')).toEqual([]);
    expect(paths('D:\\a\\b.txt_old')).toEqual([]);
    expect(paths('D:\\a\\v1.2')).toEqual([]);
  });

  it('two paths with a space between are both taken', () => {
    expect(paths('D:\\a.txt D:\\b.txt')).toEqual(['D:\\a.txt', 'D:\\b.txt']);
  });

  it('not web addresses, relative paths, or backslashes that are not paths', () => {
    expect(paths('https://example.com/C:/a.txt 和 file:///C:/a.txt')).toEqual([]);
    expect(paths('..\\a\\b.txt 和 a\\b.txt 和 \\a\\b.txt')).toEqual([]);
    expect(paths('正则 \\d+\\.txt，换行写成 \\n，\\\\n 也是')).toEqual([]);
    expect(paths('ABC:\\a.txt 和 x1C:\\a.txt')).toEqual([]);
    expect(paths('\\\\.\\pipe\\a.txt 和 \\\\?\\C:\\a.txt')).toEqual([]);
  });
});
