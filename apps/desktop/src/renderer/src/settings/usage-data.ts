// 设置 › 用量: the time ranges, and the core's summary turned into what the page draws
// (one column per bucket, one series per model, the 429 answers apart, the tokens by kind), the model
// picker's choices and the CSV. No React here.
import type { UsageQuery, UsageRow, UsageSummary } from '@spica/protocol';
import { intlLocale, N_, t } from '../../../shared/i18n';

export type UsageRange = 'today' | '7d' | '30d' | '90d';

export const RANGES: readonly [UsageRange, string][] = [
  ['today', N_('今天')],
  ['7d', N_('7 天')],
  ['30d', N_('30 天')],
  ['90d', N_('90 天')],
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

/** The kinds of token the Token chart stacks, bottom up: its legend's words and colors. */
export type TokenKind = 'cacheRead' | 'cacheWrite' | 'cacheMiss' | 'unreported' | 'output';
export const TOKEN_KINDS: readonly { kind: TokenKind; label: string; color: string }[] = [
  { kind: 'cacheRead', label: N_('缓存命中'), color: 'var(--spica-series-1)' },
  { kind: 'cacheWrite', label: N_('缓存写入'), color: 'var(--spica-series-4)' },
  { kind: 'cacheMiss', label: N_('缓存未命中'), color: 'var(--spica-series-2)' },
  // the provider gave no cache numbers: hit or miss unknown, so not a series color
  { kind: 'unreported', label: N_('输入（未报告缓存）'), color: 'var(--spica-faint)' },
  { kind: 'output', label: N_('输出'), color: 'var(--spica-series-3)' },
];

export type TokenKinds = Record<TokenKind, number>;
const noKinds = (): TokenKinds => ({ cacheRead: 0, cacheWrite: 0, cacheMiss: 0, unreported: 0, output: 0 });

/** A row's tokens by kind (a row from a core without the split: its whole input is unreported). */
export function rowKinds(r: UsageRow): TokenKinds {
  const split = r.cacheMissTokens !== undefined || r.unreportedInputTokens !== undefined;
  return {
    cacheRead: r.cacheReadTokens,
    cacheWrite: r.cacheWriteTokens,
    cacheMiss: split ? (r.cacheMissTokens ?? 0) : 0,
    unreported: split ? (r.unreportedInputTokens ?? 0) : r.inputTokens,
    output: r.outputTokens,
  };
}

export const kindsTotal = (k: TokenKinds) => k.cacheRead + k.cacheWrite + k.cacheMiss + k.unreported + k.output;

export interface UsageColumn {
  /** Start of the bucket (ms). */
  start: number;
  /** Before the request log starts: no data, not zero. */
  noData: boolean;
  /** Per series key. */
  requests: Record<string, number>;
  /** All the tokens (every kind) per series key. */
  tokens: Record<string, number>;
  /** 429 answers per series key. */
  limited: Record<string, number>;
  /** Per function module (the requests' initiator, UsageRow.byInitiator): requests, 429 answers, tokens. */
  modules: Record<string, { requests: number; rateLimited: number; tokens: number }>;
  requestCount: number;
  rateLimited: number;
  kinds: TokenKinds;
}

export interface UsageView {
  columns: UsageColumn[];
  series: UsageSeries[];
  totals: { requests: number; failed: number; rateLimited: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; unpriced: boolean; unpricedRequests: number; tokens: number; kinds: TokenKinds };
  /** When the log starts, when that is inside the range (ms); null when the whole range has data. */
  since: number | null;
  /** The log is empty. */
  empty: boolean;
}

export const OTHER_KEY = '\u0000other';
/** A model's key: its provider and name (the picker's value). */
export const keyOf = (r: Pick<UsageRow, 'providerId' | 'model'>) => `${r.providerId}\u0000${r.model}`;

/** The models with records in the summary, for the picker: by name, then provider. */
export function modelChoices(s: UsageSummary): { key: string; providerId: string; model: string }[] {
  const seen = new Map<string, { key: string; providerId: string; model: string }>();
  for (const r of s.rows) seen.set(keyOf(r), { key: keyOf(r), providerId: r.providerId, model: r.model });
  return [...seen.values()].sort((a, b) => a.model.localeCompare(b.model) || a.providerId.localeCompare(b.providerId));
}

/** The summary with only one model's rows and 429 answers (null: all of them). */
export function onlyModel(s: UsageSummary, key: string | null): UsageSummary {
  // all models: the newest 200 of them together (the core keeps up to 200 of each)
  if (!key) return { ...s, rateLimited: s.rateLimited.slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 200) };
  return { ...s, rows: s.rows.filter((r) => keyOf(r) === key), rateLimited: s.rateLimited.filter((r) => keyOf({ providerId: r.providerId ?? '', model: r.model ?? '' }) === key) };
}

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
  if (keys.length > shown.size) series.set(OTHER_KEY, blank(OTHER_KEY, '', t('其他'), 'var(--spica-faint)'));

  const columns: UsageColumn[] = [];
  const byStart = new Map<number, UsageColumn>();
  for (let t = first; t <= to; t += step) {
    // a day bucket may be 23 or 25 hours at a clock change: snap to the local midnight after it
    const start = s.query.bucket === 'day' ? Math.round((t + off) / DAY) * DAY - off : t;
    const col: UsageColumn = { start, noData: since === null || start + step <= since, requests: {}, tokens: {}, limited: {}, modules: {}, requestCount: 0, rateLimited: 0, kinds: noKinds() };
    columns.push(col);
    byStart.set(start, col);
  }
  const totals = { requests: 0, failed: 0, rateLimited: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, unpriced: false, unpricedRequests: 0, tokens: 0, kinds: noKinds() };
  for (const r of s.rows) {
    const kinds = rowKinds(r);
    const all = kindsTotal(kinds);
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
    totals.tokens += all;
    for (const t of TOKEN_KINDS) totals.kinds[t.kind] += kinds[t.kind];
    const col = byStart.get(Date.parse(r.bucket));
    if (!col) continue;
    col.noData = false;
    col.requests[k] = (col.requests[k] ?? 0) + r.requests;
    col.tokens[k] = (col.tokens[k] ?? 0) + all;
    col.limited[k] = (col.limited[k] ?? 0) + r.rateLimited;
    col.requestCount += r.requests;
    col.rateLimited += r.rateLimited;
    for (const t of TOKEN_KINDS) col.kinds[t.kind] += kinds[t.kind];
    for (const [who, u] of Object.entries(r.byInitiator ?? {})) {
      const m = (col.modules[moduleKey(who)] ??= { requests: 0, rateLimited: 0, tokens: 0 });
      m.requests += u.requests;
      m.rateLimited += u.rateLimited;
      m.tokens += u.tokens;
    }
  }
  return { columns, series: [...series.values()], totals, since: since !== null && since > from ? since : null, empty: since === null };
}

/**
 * The function module of a request's initiator: a conversation, memory tidying, a test of the connection, a plugin
 * (its model borrowing and its views: one module per plugin); anything else as it is.
 */
export function moduleKey(initiator: string): string {
  if (initiator.startsWith('view:')) return `plugin:${initiator.slice(5)}`;
  return initiator;
}

/**
 * The module's name on the hover card. A plugin by the name its page shows (`pluginName`); its id only when that is
 * not known (uninstalled since).
 */
export function moduleLabel(key: string, pluginName: (id: string) => string | undefined = () => undefined): string {
  if (key === 'model') return t('对话');
  if (key === 'runtime:memory-tidy') return t('记忆整理');
  if (key === 'runtime:probe') return t('测试连接');
  if (key.startsWith('plugin:')) return t('插件 {name}', { name: pluginName(key.slice(7)) || key.slice(7) });
  return key || t('其他');
}

/** The fixed order of the modules on the card: 对话, 记忆整理, the plugins, 测试连接, the rest. */
export function moduleOrder(key: string): number {
  return key === 'model' ? 0 : key === 'runtime:memory-tidy' ? 1 : key.startsWith('plugin:') ? 2 : key === 'runtime:probe' ? 3 : 4;
}

/** 1,234 · 12.3K · 4.5M · 1.2B: short counts for tiles and axes. */
export function shortCount(n: number): string {
  const a = Math.abs(n);
  const fix = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/\.?0+$/, ''));
  if (a >= 1e9) return `${fix(n / 1e9)}B`;
  if (a >= 1e6) return `${fix(n / 1e6)}M`;
  if (a >= 1e4) return `${fix(n / 1e3)}K`;
  return n.toLocaleString(intlLocale());
}

/** US$0.0123 · US$1.23 · US$123 (in English $0.0123 …): cost as the page writes it, in the interface's language. */
export function usd(n: number): string {
  const digits = n === 0 || n >= 100 ? 0 : n >= 1 ? 2 : 4;
  return new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(n);
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

/** The CSV's columns (the header row). */
export const CSV_HEAD = [N_('时间'), N_('服务商'), N_('模型|single'), N_('请求'), '429', N_('失败'), N_('输入'), N_('输出'), N_('缓存读'), N_('缓存写'), N_('花费（美元）')] as const;

/**
 * The summary as CSV rows, one per time bucket and model (header first): the bucket's start in local time
 * (2026-11-13, or 2026-11-13 14:00 by the hour), the counts as plain numbers, the cost blank when the model
 * has no price.
 */
export function usageCsvRows(s: UsageSummary, provider: (id: string) => string): string[][] {
  const time = (iso: string) => {
    const ms = Date.parse(iso);
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return s.query.bucket === 'hour' ? `${dayLabel(ms)} ${pad(d.getHours())}:00` : dayLabel(ms);
  };
  const cost = (r: UsageRow) => (r.unpriced && !r.costUsd ? '' : String(Math.round(r.costUsd * 1e6) / 1e6));
  return [
    CSV_HEAD.map((h) => t(h)),
    ...s.rows.map((r) => [time(r.bucket), r.providerId ? provider(r.providerId) : '', r.model, r.requests, r.rateLimited, r.failed, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens].map(String).concat(cost(r))),
  ];
}

/** The file's name: 用量-20261107-20261113.csv, with the model when one is picked. */
export function usageCsvName(s: UsageSummary, model: string | null): string {
  const day = (iso: string) => dayLabel(Date.parse(iso)).replaceAll('-', '');
  const name = t('用量');
  return `${name}-${day(s.query.from)}-${day(s.query.to)}${model ? `-${model}` : ''}.csv`;
}
