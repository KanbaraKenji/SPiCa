import { describe, expect, it } from 'vitest';
import type { CwdChangeMeta } from '@spica/protocol';
import { changesAfter, relocate, sameFolder, shownPath } from './relocate';

const FROM = 'C:\\Users\\me\\AppData\\Roaming\\Spica\\sessions\\ses_1\\files';
const TO = 'D:\\资料\\报价';
const moved: CwdChangeMeta = {
  from: FROM,
  to: TO,
  moved: [
    { from: '报价.md', to: '报价 (1).md' },
    { from: '备注.txt', to: '备注.txt' },
    { from: 'data\\a.csv', to: 'data\\a.csv' },
  ],
  renamed: [{ from: '报价.md', to: '报价 (1).md' }],
};

describe('relocate: where a file named before the working-folder note is now', () => {
  it('no change after it: the path as written', () => {
    expect(relocate('报价.md', undefined)).toBe('报价.md');
  });

  it('renamed on the way: the new name in the new folder, not the same-named file already there', () => {
    expect(relocate('报价.md', moved)).toBe('D:\\资料\\报价\\报价 (1).md');
    expect(relocate(`${FROM}\\报价.md`, moved)).toBe('D:\\资料\\报价\\报价 (1).md');
  });

  it('moved under its own name, also in a sub-folder, with either separator or case', () => {
    expect(relocate('备注.txt', moved)).toBe('D:\\资料\\报价\\备注.txt');
    expect(relocate('data/a.csv', moved)).toBe('D:\\资料\\报价\\data\\a.csv');
    expect(relocate(`${FROM.toLowerCase()}\\DATA\\A.csv`, moved)).toBe('D:\\资料\\报价\\data\\a.csv');
  });

  it('a file of the old folder that was not moved keeps its old path (it says it cannot be found), never one in the new folder', () => {
    expect(relocate('已删除.md', moved)).toBe(`${FROM}\\已删除.md`);
  });

  it('a file outside the conversation’s own folder is left as it is', () => {
    expect(relocate('E:\\共享\\合同.pdf', moved)).toBe('E:\\共享\\合同.pdf');
  });

  it('a conversation from 0.1.0-rc.2: its files stayed in the shared folder', () => {
    const stay: CwdChangeMeta = { from: 'C:\\Users\\me\\Documents\\Spica', to: TO, moved: [], renamed: [], filesStayIn: 'C:\\Users\\me\\Documents\\Spica' };
    expect(relocate('报价.md', stay)).toBe('C:\\Users\\me\\Documents\\Spica\\报价.md');
    expect(relocate('C:\\Users\\me\\Documents\\Spica\\sub\\x.txt', stay)).toBe('C:\\Users\\me\\Documents\\Spica\\sub\\x.txt');
  });

  it('macOS-style paths join with /', () => {
    const mac: CwdChangeMeta = { from: '/Users/me/Library/Spica/sessions/s/files', to: '/Users/me/报价', moved: [{ from: 'a.md', to: 'a (1).md' }], renamed: [{ from: 'a.md', to: 'a (1).md' }] };
    expect(relocate('a.md', mac)).toBe('/Users/me/报价/a (1).md');
  });
});

describe('changesAfter', () => {
  it('each answer before the note gets that change; answers after it get none', () => {
    const items = [
      { kind: 'response', id: 'r1' },
      { kind: 'user', id: 'u2' },
      { kind: 'response', id: 'r2' },
      { kind: 'note', id: 'n', cwd: moved },
      { kind: 'response', id: 'r3' },
    ];
    const m = changesAfter(items);
    expect(m.get('r1')).toBe(moved);
    expect(m.get('r2')).toBe(moved);
    expect(m.has('r3')).toBe(false);
  });
});

describe('sameFolder', () => {
  it('ignores case, separators and a trailing separator', () => {
    expect(sameFolder('C:\\Users\\me\\Documents\\Spica\\', 'c:/users/me/documents/spica')).toBe(true);
    expect(sameFolder('C:\\Users\\me\\Documents\\Spica\\sub', 'C:\\Users\\me\\Documents\\Spica')).toBe(false);
    expect(sameFolder('C:\\x', undefined)).toBe(false);
  });
});

describe('shownPath', () => {
  it('moved into the conversation’s folder: its path in there; left in the old shared folder: the full path', () => {
    expect(shownPath('D:\\资料\\报价\\data\\a.csv', moved)).toBe('data\\a.csv');
    const shared = 'C:\\Users\\me\\Documents\\Spica';
    const stay: CwdChangeMeta = { ...moved, moved: [], renamed: [], filesStayIn: shared };
    expect(shownPath(`${shared}\\报价.md`, stay)).toBe(`${shared}\\报价.md`);
  });
});
