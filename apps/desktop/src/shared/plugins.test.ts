import { describe, expect, it } from 'vitest';
import { spentText, usd } from './plugins';

describe('plugin money', () => {
  it('limits as they were set: at least two decimals, up to four', () => {
    expect(usd(0.1)).toBe('$0.10');
    expect(usd(0.05)).toBe('$0.05');
    expect(usd(0.015)).toBe('$0.015');
    expect(usd(0.0203)).toBe('$0.0203');
  });

  it('spent with the same decimals; a fraction too small for them is not shown as nothing', () => {
    expect(spentText(0.0002667)).toBe('$0.0003');
    expect(spentText(0.00002)).toBe('< $0.0001');
    expect(spentText(0)).toBe('$0.00');
    expect(spentText(0.034)).toBe('$0.034');
  });
});
