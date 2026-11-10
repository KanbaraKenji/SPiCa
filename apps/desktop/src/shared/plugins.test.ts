import { describe, expect, it } from 'vitest';
import { spentText, usd } from './plugins';

describe('plugin money', () => {
  it('limits in dollars and cents', () => {
    expect(usd(0.1)).toBe('$0.10');
    expect(usd(0.05)).toBe('$0.05');
  });

  it('a fraction of a cent spent is not shown as nothing', () => {
    expect(spentText(0.0002667)).toBe('< $0.01');
    expect(spentText(0)).toBe('$0.00');
    expect(spentText(0.034)).toBe('$0.03');
  });
});
