import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isBinary, parseWordList, scanFiles, scanText } from './scanner.mjs';

// Words are built at runtime so this file never contains them literally.
const planted = ['zeb', 'raquartz'].join('');

describe('sensitive-word scanner', () => {
  it('parses words, skipping comments and blank lines', () => {
    expect(parseWordList('# note\n\n  Foo \nbar\n')).toEqual([
      { word: 'foo', line: 3 },
      { word: 'bar', line: 4 },
    ]);
  });

  it('matches case-insensitively and reports line numbers', () => {
    const entries = [{ list: 'l.txt', word: planted, line: 1 }];
    const hits = scanText(`ok\nhas ${planted.toUpperCase()} here\nok`, entries);
    expect(hits).toEqual([{ line: 2, list: 'l.txt', entryLine: 1 }]);
  });

  it('scans files, skips binaries and the word list itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-scan-'));
    const list = join(dir, 'words.txt');
    writeFileSync(list, `${planted}\n`);
    writeFileSync(join(dir, 'a.md'), `line one\nmentions ${planted}\n`);
    writeFileSync(join(dir, 'b.bin'), Buffer.from([0, 1, 2, ...Buffer.from(planted)]));
    writeFileSync(join(dir, 'c.ts'), 'clean\n');
    const entries = [{ list: 'words.txt', word: planted, line: 1 }];
    const hits = scanFiles({ root: dir, files: ['a.md', 'b.bin', 'c.ts', 'words.txt'], listPaths: [list], entries });
    expect(hits).toEqual([{ file: 'a.md', line: 2, list: 'words.txt', entryLine: 1 }]);
    expect(isBinary(Buffer.from([65, 0]))).toBe(true);
  });
});
