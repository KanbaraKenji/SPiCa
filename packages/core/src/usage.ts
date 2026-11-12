// The request log summed up for the usage page: per time bucket, provider and
// model, the requests, failures, 429 answers, tokens and cost. One function for
// the real core and the demo backend, so the demo shows what the code computes.
import type { RequestRecord, UsageQuery, UsageRow, UsageSummary } from './types.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The 429 answers listed one by one. */
const RATE_LIMITED_LIST = 200;

/** Start of the bucket holding `t` (ms), as ms: whole UTC hours, or days starting at the given offset. */
export function bucketStart(t: number, bucket: UsageQuery['bucket'], tzOffsetMinutes = 0): number {
  if (bucket === 'hour') return Math.floor(t / HOUR) * HOUR;
  const off = tzOffsetMinutes * 60_000;
  return Math.floor((t + off) / DAY) * DAY - off;
}

/** A 429: the status, or the code when no status was kept. */
export function isRateLimited(r: Pick<RequestRecord, 'httpStatus' | 'errorCode'>): boolean {
  return r.httpStatus === 429 || (r.httpStatus === undefined && r.errorCode === 'gateway.rate_limited');
}

/**
 * Sum `records` (any order) inside the query's range. `since`: when the log starts (store.firstRequestAt()).
 * Rows are sorted by bucket, then provider and model.
 */
export function summarizeRequests(records: readonly RequestRecord[], query: UsageQuery, since: string | null): UsageSummary {
  const from = Date.parse(query.from);
  const to = Date.parse(query.to);
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error('from / to must be ISO 8601 dates');
  const rows = new Map<string, UsageRow>();
  const limited: RequestRecord[] = [];
  for (const r of records) {
    const t = Date.parse(r.startedAt);
    if (Number.isNaN(t) || t < from || t > to) continue;
    const bucket = new Date(bucketStart(t, query.bucket, query.tzOffsetMinutes)).toISOString();
    const providerId = r.providerId ?? '';
    const model = r.model ?? '';
    const key = `${bucket}\u0000${providerId}\u0000${model}`;
    let row = rows.get(key);
    if (!row) {
      row = { bucket, providerId, model, requests: 0, ok: 0, failed: 0, rateLimited: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
      rows.set(key, row);
    }
    row.requests++;
    if (r.status === 'ok') row.ok++;
    else row.failed++;
    if (isRateLimited(r)) {
      row.rateLimited++;
      limited.push(r);
    }
    row.inputTokens += r.inputTokens ?? 0;
    row.outputTokens += r.outputTokens ?? 0;
    row.cacheReadTokens += r.cacheReadTokens ?? 0;
    row.cacheWriteTokens += r.cacheWriteTokens ?? 0;
    if (r.unpriced) row.unpriced = true;
    else row.costUsd += r.costUsd ?? 0;
  }
  const sorted = [...rows.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : a.providerId.localeCompare(b.providerId) || a.model.localeCompare(b.model)));
  limited.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return { since, query: { ...query }, rows: sorted, rateLimited: limited.slice(0, RATE_LIMITED_LIST) };
}
