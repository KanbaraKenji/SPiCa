import { describe, expect, it } from 'vitest';
import { spendText } from './spend';

const usd = (n: number) => `$${n.toFixed(2)}`;

describe('a spend as shown', () => {
  it('a number when every call had a price; 未计价 for calls without one, never as 0', () => {
    expect(spendText(0.12, false, usd)).toBe('$0.12');
    expect(spendText(0, undefined, usd)).toBe('$0.00');
    expect(spendText(0, true, usd)).toBe('未计价');
    expect(spendText(0.12, true, usd)).toBe('$0.12 + 未计价');
  });
});
