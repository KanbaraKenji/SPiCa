import { describe, expect, it } from 'vitest';
import { ASK, DAY_PARTS, LINES, dayPart, greeting, lineFor, todayLine, welcome } from './welcome';

/** 2026-11-12 is a Thursday; local time. */
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m);

describe('the greeting', () => {
  it('follows the time of day, the edges included', () => {
    const said = (h: number, m = 0) => dayPart(at(12, h, m)).greeting;
    expect([said(4, 59), said(5), said(8, 59), said(9), said(11, 29), said(11, 30), said(13, 29), said(13, 30), said(17, 59), said(18), said(22, 59), said(23), said(0)]).toEqual([
      '夜深了',
      '早上好',
      '早上好',
      '上午好',
      '上午好',
      '中午好',
      '中午好',
      '下午好',
      '下午好',
      '晚上好',
      '晚上好',
      '夜深了',
      '夜深了',
    ]);
  });

  it('with the name after a comma; without one, never a comma with nothing after it', () => {
    expect(greeting(at(12, 15), 'Alex')).toBe('下午好，Alex');
    expect(greeting(at(12, 15), '')).toBe('下午好');
    expect(greeting(at(12, 15), '  ')).toBe('下午好');
  });
});

describe('the line under it', () => {
  it('a: the question the page always asked', () => {
    expect(welcome({ now: at(12, 15), name: 'Alex', waiting: 2, style: 'a' })).toEqual({ title: '下午好，Alex', line: ASK });
  });

  it('b: the narrowest line that fits; the same all day part long', () => {
    // Monday 2026-11-09 morning, Friday 2026-11-13 afternoon, Saturday 2026-11-14, Thursday late
    expect(lineFor(at(9, 8))).toBe('新的一周，先从最要紧的一件开始。');
    expect(lineFor(at(13, 15))).toBe('周五下午了，把这周没收尾的事理一理？');
    expect(lineFor(at(14, 10))).toBe('周末还在忙，有什么我先接过来。');
    expect(lineFor(at(12, 23, 30))).toBe('这么晚了，要做的我先记下，明天接着做也可以。');
    expect(lineFor(at(12, 14))).toBe(lineFor(at(12, 17, 59)));
    expect(['下午的事，从哪件开始？', '有文件要整理、报告要写，可以交给我。']).toContain(lineFor(at(12, 14)));
  });

  it('b: every part of every day has a line; the words keep to the app’s voice', () => {
    for (let day = 8; day <= 14; day++) for (const p of DAY_PARTS) expect(lineFor(at(day, p.from[0], p.from[1]))).not.toBe(ASK);
    for (const l of LINES) {
      expect(l.text).not.toMatch(/[!！~～]/);
      expect(l.text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('c: the date and the week day, and the conversations waiting when there are any', () => {
    expect(todayLine(at(12, 15), 0)).toBe('11月12日 星期四');
    expect(todayLine(at(12, 15), 2)).toBe('11月12日 星期四 · 2 条对话在等你回答或确认');
    expect(welcome({ now: at(12, 15), name: '', waiting: 1, style: 'c' })).toEqual({ title: '下午好', line: '11月12日 星期四 · 1 条对话在等你回答或确认' });
  });
});
