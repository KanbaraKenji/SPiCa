// 设置 › 用量: the time ranges, and the core's summary turned into what the page draws
// (one column per bucket, one series per model, the 429 answers apart). No React here.
import type { UsageQuery, UsageRow, UsageSummary } from '@spica/protocol';

export type UsageRange = 'today' | '7d' | '30d' | '90d';

export const RANGES: readonly [UsageRange, string][] = [
  ['today', '今天'],
  ['7d', '7 天'],
  ['30d', '30 天'],
  ['90d', '90 天'],
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The query for a range ending now: today by the hour (from local midnight), the others by the day (whole local days). */
export function queryFor(range: UsageRange, now: Date): UsageQuery {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = range === 'today' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const from = new Date(midnight.getTime());
  from.setDate(from.getDate() - (days - 1));
  return { from: from.toISOString(), to: now.toISOString(), bucket: range === 'today' ? 'hour' : 'day', tzOffsetMinutes: -now.getTimezoneOffset() };
}

/** One model as the page shows it: its key, names and its series color (by a fixed order of the keys, not by size). */
export interface UsageSeries {
  key: string;
  providerId: string;
  model: string;
  /** CSS color: a series token, or the faint ink for 其他. */
  color: string;
  requests: number;
  ok: number;
  failed: number;
  rateLimited: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  unpriced: boolean;
  /** Requests of a model without a price (not in costUsd). */
  unpricedRequests: number;
}

export interface UsageColumn {
  /** Start of the bucket (ms). */
  start: number;
  /** Before the request log starts: no data, not zero. */
  noData: boolean;
  /** Per series key. */
  requests: Record<string, number>;
  tokens: Record<string, number>;
  rateLimited: number;
}

export interface UsageView {
  columns: UsageColumn[];
  series: UsageSeries[];
  totals: { requests: number; failed: number; rateLimited: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; unpriced: boolean; unpricedRequests: number };
  /** When the log starts, when that is inside the range (ms); null when the whole range has data. */
  since: number | null;
  /** The log is empty. */
  empty: boolean;
}

export const OTHER_KEY = '\u0000other';
const keyOf = (r: Pick<UsageRow, 'providerId' | 'model'>) => `${r.providerId}\u0000${r.model}`;

/**
 * Columns for every bucket of the range (also the empty ones and those before the log starts), and one series
 * per model: the first `maxSeries` by a fixed order (provider, then model name), the rest folded into 其他.
 */
export function usageView(s: UsageSummary, maxSeries: number): UsageView {
  const step = s.query.bucket === 'hour' ? HOUR : DAY;
  const off = (s.query.tzOffsetMinutes ?? 0) * 60_000;
  const from = Date.parse(s.query.from);
  const to = Date.parse(s.query.to);
  const first = s.query.bucket === 'hour' ? Math.floor(from / HOUR) * HOUR : Math.floor((from + off) / DAY) * DAY - off;
  const since = s.since ? Date.parse(s.since) : null;

  const keys = [...new Set(s.rows.map(keyOf))].sort((a, b) => a.localeCompare(b));
  const shown = new Set(keys.slice(0, keys.length > maxSeries ? maxSeries - 1 : maxSeries));
  const seriesKey = (k: string) => (shown.has(k) ? k : OTHER_KEY);
  const series = new Map<string, UsageSeries>();
  const blank = (key: string, providerId: string, model: string, color: string): UsageSeries => ({ key, providerId, model, color, requests: 0, ok: 0, failed: 0, rateLimited: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, unpriced: false, unpricedRequests: 0 });
  [...shown].forEach((k, i) => {
    const [providerId = '', model = ''] = k.split('\u0000');
    series.set(k, blank(k, providerId, model, `var(--spica-series-${i + 1})`));
  });
  if (keys.length > shown.size) series.set(OTHER_KEY, blank(OTHER_KEY, '', '其他', 'var(--spica-faint)'));

  const columns: UsageColumn[] = [];
  const byStart = new Map<number, UsageColumn>();
  for (let t = first; t <= to; t += step) {
    // a day bucket may be 23 or 25 hours at a clock change: snap to the local midnight after it
    const start = s.query.bucket === 'day' ? Math.round((t + off) / DAY) * DAY - off : t;
    const col: UsageColumn = { start, noData: since === null || start + step <= since, requests: {}, tokens: {}, rateLimited: 0 };
    columns.push(col);
    byStart.set(start, col);
  }
  const totals = { requests: 0, failed: 0, rateLimited: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, unpriced: false, unpricedRequests: 0 };
  for (const r of s.rows) {
    const k = seriesKey(keyOf(r));
    const se = series.get(k)!;
    se.requests += r.requests;
    se.ok += r.ok;
    se.failed += r.failed;
    se.rateLimited += r.rateLimited;
    se.inputTokens += r.inputTokens;
    se.outputTokens += r.outputTokens;
    se.cacheReadTokens += r.cacheReadTokens;
    se.cacheWriteTokens += r.cacheWriteTokens;
    se.costUsd += r.costUsd;
    if (r.unpriced) se.unpriced = true;
    se.unpricedRequests += r.unpricedRequests ?? 0;
    totals.unpricedRequests += r.unpricedRequests ?? 0;
    totals.requests += r.requests;
    totals.failed += r.failed;
    totals.rateLimited += r.rateLimited;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.cacheReadTokens += r.cacheReadTokens;
    totals.cacheWriteTokens += r.cacheWriteTokens;
    totals.costUsd += r.costUsd;
    if (r.unpriced) totals.unpriced = true;
    const col = byStart.get(Date.parse(r.bucket));
    if (!col) continue;
    col.noData = false;
    col.requests[k] = (col.requests[k] ?? 0) + r.requests;
    col.tokens[k] = (col.tokens[k] ?? 0) + r.inputTokens + r.outputTokens;
    col.rateLimited += r.rateLimited;
  }
  return { columns, series: [...series.values()], totals, since: since !== null && since > from ? since : null, empty: since === null };
}

/** 1,234 · 12.3K · 4.5M · 1.2B: short counts for tiles and axes. */
export function shortCount(n: number): string {
  const a = Math.abs(n);
  const fix = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/\.?0+$/, ''));
  if (a >= 1e9) return `${fix(n / 1e9)}B`;
  if (a >= 1e6) return `${fix(n / 1e6)}M`;
  if (a >= 1e4) return `${fix(n / 1e3)}K`;
  return n.toLocaleString('en-US');
}

/** US$0.0123 · US$1.23 · US$123: cost as the page writes it. */
export function usd(n: number): string {
  if (n === 0) return 'US$0';
  return `US$${n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(4)}`;
}

/** The label under a column: 14:00 for an hour, 11/13 for a day. */
export function bucketLabel(start: number, bucket: UsageQuery['bucket']): string {
  const d = new Date(start);
  const pad = (n: number) => String(n).padStart(2, '0');
  return bucket === 'hour' ? `${pad(d.getHours())}:00` : `${d.getMonth() + 1}/${d.getDate()}`;
}

/** A point in time as the 429 list writes it: 11/13 14:05:09. */
export function timeLabel(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The day the log starts, written in full: 2026-11-13. */
export function dayLabel(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A round axis top at or above `max` (1, 2, 5 × 10ⁿ), and its ticks. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
