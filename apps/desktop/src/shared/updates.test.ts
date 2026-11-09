import { describe, expect, it } from 'vitest';
import { activeNotices, compareVersions, parseLatestYml, parseNotices } from './updates';

describe('compareVersions', () => {
  it('orders x.y.z and puts pre-releases first', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });
});

describe('parseLatestYml', () => {
  it('reads what electron-builder writes', () => {
    const yml = [
      'version: 0.1.1',
      'files:',
      '  - url: Spica-Setup-0.1.1.exe',
      '    sha512: abc==',
      '    size: 10',
      'path: Spica-Setup-0.1.1.exe',
      'sha512: abc==',
      "releaseDate: '2026-11-09T12:09:03.791Z'",
    ].join('\n');
    expect(parseLatestYml(yml)).toEqual({ version: '0.1.1', path: 'Spica-Setup-0.1.1.exe', sha512: 'abc==' });
  });
  it('refuses a file name that points elsewhere', () => {
    expect(parseLatestYml('version: 1.0.0\npath: ..\\evil.exe\nsha512: x')).toBeUndefined();
    expect(parseLatestYml('nothing here')).toBeUndefined();
  });
});

describe('notices', () => {
  const file = {
    announcements: [
      { id: 'a', text: '周六晚上 8 点到 10 点网关维护', level: 'warning', start: '2026-11-01', end: '2026-11-30' },
      { id: 'b', text: '新版插件已上线', link: 'https://intranet.example/notes' },
      { id: 'c', text: '   ' },
      { id: 'd', text: '旧消息', end: '2026-01-01' },
      { text: '没有 id' },
      { id: 'e', text: '坏链接', link: 'javascript:alert(1)' },
    ],
  };
  it('keeps only well-formed notices and safe links', () => {
    const n = parseNotices(file);
    expect(n.map((x) => x.id)).toEqual(['a', 'b', 'd', 'e']);
    expect(n.find((x) => x.id === 'e')?.link).toBeUndefined();
    expect(parseNotices('garbage')).toEqual([]);
  });
  it('shows what is in its time window and not closed', () => {
    const n = parseNotices(file);
    expect(activeNotices(n, ['b'], new Date('2026-11-09T12:00:00Z')).map((x) => x.id)).toEqual(['a', 'e']);
  });
});
