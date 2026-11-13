import { describe, expect, it } from 'vitest';
import { CHANGE_MAX_LINES, fileChange } from './line-diff.ts';

const numbered = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `l${i + from}`);

describe('fileChange (the window’s view of a write or an edit)', () => {
  it('nothing changed: none', () => {
    expect(fileChange('a\nb\n', 'a\nb\n')).toBeUndefined();
    expect(fileChange('a\r\nb\r\n', 'a\nb\n')).toBeUndefined();
  });

  it('changes far apart are hunks of their own; close ones share one (the unchanged lines between shown once)', () => {
    const old = numbered(30);
    const far = [...old];
    far[2] = 'X';
    far[25] = 'Y';
    expect(fileChange(old.join('\n'), far.join('\n'))!.hunks.map((h) => [h.oldStart, h.lines.length])).toEqual([
      [1, 7],
      [23, 8],
    ]);
    const near = [...old];
    near[10] = 'X';
    near[17] = 'Y'; // six unchanged lines between: one hunk
    const h = fileChange(old.join('\n'), near.join('\n'))!.hunks;
    expect(h).toHaveLength(1);
    expect(h[0]!.lines.filter((l) => l[0] !== ' ')).toEqual(['-l11', '+X', '-l18', '+Y']);
  });

  it('a line added at the start and one removed at the end: one hunk (four unchanged lines between)', () => {
    expect(fileChange('a\nb\nc\nd\ne\n', 'new\na\nb\nc\nd\n')).toEqual({
      hunks: [{ oldStart: 1, newStart: 1, lines: ['+new', ' a', ' b', ' c', ' d', '-e'] }],
    });
  });

  it('numbered in each file: after lines were added above, the new file’s numbers run ahead', () => {
    const old = numbered(20);
    const now = ['a', 'b', ...old];
    now[15] = 'X';
    expect(fileChange(old.join('\n'), now.join('\n'))!.hunks[1]).toEqual({ oldStart: 11, newStart: 13, lines: [' l11', ' l12', ' l13', '-l14', '+X', ' l15', ' l16', ' l17'] });
  });

  it('an empty file written: every line added', () => {
    expect(fileChange('', 'x\ny')).toEqual({ hunks: [{ oldStart: 1, newStart: 1, lines: ['+x', '+y'] }] });
  });

  it('more changed lines than the limit: the hunk that crosses it is cut there, the ones after are left out', () => {
    const many = numbered(CHANGE_MAX_LINES + 500);
    const c = fileChange('', many.join('\n'))!;
    expect(c.truncated).toBe(true);
    expect(c.hunks).toHaveLength(1);
    expect(c.hunks[0]!.lines).toHaveLength(CHANGE_MAX_LINES);
    expect(c.hunks[0]!.lines.at(-1)).toBe(`+l${CHANGE_MAX_LINES}`);
    const every10 = numbered(30000).map((l, i) => (i % 10 === 0 ? `${l}!` : l));
    const d = fileChange(numbered(30000).join('\n'), every10.join('\n'))!;
    expect(d.truncated).toBe(true);
    expect(d.hunks.reduce((n, h) => n + h.lines.length, 0)).toBeLessThanOrEqual(CHANGE_MAX_LINES);
  });
});
