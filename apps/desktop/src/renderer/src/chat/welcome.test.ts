import { describe, expect, it } from 'vitest';
import { dayGreeting, greeting } from './welcome';

/** 2026-11-12, local time. */
const at = (h: number, m = 0) => new Date(2026, 10, 12, h, m);

describe('the greeting', () => {
  it('follows the time of day, the edges included', () => {
    const said = (h: number, m = 0) => dayGreeting(at(h, m));
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
    expect(greeting(at(15), 'Alex')).toBe('下午好，Alex');
    expect(greeting(at(15), '')).toBe('下午好');
    expect(greeting(at(15), '  ')).toBe('下午好');
  });
});
