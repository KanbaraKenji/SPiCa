import { describe, expect, it } from 'vitest';
import { formatClock } from './format';

describe('formatClock: a run’s ticking clock', () => {
  it('seconds under a minute, minutes and seconds under an hour, hours and minutes after', () => {
    expect(formatClock(0)).toBe('0s');
    expect(formatClock(999)).toBe('0s');
    expect(formatClock(59_000)).toBe('59s');
    expect(formatClock(60_000)).toBe('1m 0s');
    expect(formatClock(61_000)).toBe('1m 1s');
    expect(formatClock(125_000)).toBe('2m 5s');
    expect(formatClock((59 * 60 + 59) * 1000)).toBe('59m 59s');
    expect(formatClock(3_600_000)).toBe('1h 0m');
    expect(formatClock((3600 + 2 * 60 + 9) * 1000)).toBe('1h 2m');
    expect(formatClock((26 * 3600 + 5 * 60) * 1000)).toBe('26h 5m');
  });

  it('a clock behind the start (a moment before the first tick) says 0s', () => {
    expect(formatClock(-1500)).toBe('0s');
  });
});
