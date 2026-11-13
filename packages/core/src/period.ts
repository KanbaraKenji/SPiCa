// A spending limit's period: fixed periods of some days from when the limit was set. No Node imports (the desktop
// demo backend and its renderer tests use it too).

export interface SpendPeriod {
  days: number;
  /** When the first period started (ms): the limit was set or changed then. */
  fromMs: number;
}

const DAY_MS = 86_400_000;

/** The period `now` falls in: fixed periods of `days` days from `fromMs` (one starting at `fromMs` while before it). */
export function periodBounds(p: SpendPeriod, nowMs: number): { startMs: number; endMs: number } {
  const len = Math.max(1, p.days) * DAY_MS;
  const n = Math.max(0, Math.floor((nowMs - p.fromMs) / len));
  const startMs = p.fromMs + n * len;
  return { startMs, endMs: startMs + len };
}

