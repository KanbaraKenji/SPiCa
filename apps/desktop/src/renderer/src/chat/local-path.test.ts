import { describe, expect, it } from 'vitest';
import { fullPath, inlineCodeSpans, insideFolder, localPathKind, openablePathKind, pathLabel } from './local-path';

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

describe('the inline code of an answer', () => {
  it('finds spans of any number of backticks, not the code in code blocks', () => {
    const text = '看 `D:\\a.txt` 和 ``D:\\b`c.txt``\n\n```\n`D:\\in-block.txt`\n```\n\n~~~\n`D:\\tilde.txt`\n~~~\n\n还有 ` D:\\c.txt `';
    expect(inlineCodeSpans(text)).toEqual(['D:\\a.txt', 'D:\\b`c.txt', 'D:\\c.txt']);
  });

  it('a code block still being written hides the rest of the answer', () => {
    expect(inlineCodeSpans('`D:\\a.txt`\n\n```\n`D:\\b.txt`')).toEqual(['D:\\a.txt']);
  });
});
