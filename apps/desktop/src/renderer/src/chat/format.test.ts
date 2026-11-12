import { describe, expect, it } from 'vitest';
import { formatClock, formatDuration, fullTime, relativeTime } from './format';

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

describe('formatDuration: how long something took, written as the clock is', () => {
  it('<1s under a second, then as the clock', () => {
    expect(formatDuration(0)).toBe('<1s');
    expect(formatDuration(999)).toBe('<1s');
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(59_900)).toBe('59s');
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(125_400)).toBe('2m 5s');
    expect(formatDuration(3_725_000)).toBe('1h 2m');
  });
});

describe('relativeTime: when a message was written, from now', () => {
  const now = new Date(2026, 10, 12, 15, 0, 0).getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();

  it('just now under a minute (and a moment ahead of the clock)', () => {
    expect(relativeTime(ago(0), now)).toBe('just now');
    expect(relativeTime(ago(59_999), now)).toBe('just now');
    expect(relativeTime(ago(-30_000), now)).toBe('just now');
  });

  it('minutes and hours, one without an s', () => {
    expect(relativeTime(ago(60_000), now)).toBe('1 minute ago');
    expect(relativeTime(ago(119_000), now)).toBe('1 minute ago');
    expect(relativeTime(ago(9 * 60_000), now)).toBe('9 minutes ago');
    expect(relativeTime(ago(59 * 60_000 + 59_000), now)).toBe('59 minutes ago');
    expect(relativeTime(ago(3_600_000), now)).toBe('1 hour ago');
    expect(relativeTime(ago(5 * 3_600_000), now)).toBe('5 hours ago');
    expect(relativeTime(ago(23 * 3_600_000 + 59 * 60_000), now)).toBe('23 hours ago');
  });

  it('a day or more by the calendar: yesterday, N days ago, then the date (with the year when not this one)', () => {
    expect(relativeTime(at(2026, 11, 11, 8), now)).toBe('yesterday');
    expect(relativeTime(at(2026, 11, 10, 20), now)).toBe('2 days ago');
    expect(relativeTime(at(2026, 11, 6), now)).toBe('6 days ago');
    expect(relativeTime(at(2026, 11, 5), now)).toBe('Nov 5');
    expect(relativeTime(at(2025, 12, 31), now)).toBe('Dec 31, 2025');
  });

  it('not a date: nothing', () => {
    expect(relativeTime('', now)).toBe('');
    expect(relativeTime('later', now)).toBe('');
    expect(fullTime('later')).toBe('');
  });

  it('the full moment for the hover', () => {
    expect(fullTime(new Date(2026, 10, 12, 9, 5).toISOString())).toBe('2026年11月12日 09:05');
  });
});
