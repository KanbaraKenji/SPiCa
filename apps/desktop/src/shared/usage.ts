// 设置 › 用量: what the page may ask the core for (checked in the main process before it goes on).
import type { UsageQuery } from '@spica/protocol';

/** A query from the page, or null when it is not one (dates that do not parse, an unknown bucket). */
export function usageQuery(v: unknown): UsageQuery | null {
  if (!v || typeof v !== 'object') return null;
  const q = v as Record<string, unknown>;
  const from = typeof q.from === 'string' ? q.from : '';
  const to = typeof q.to === 'string' ? q.to : '';
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return null;
  if (q.bucket !== 'hour' && q.bucket !== 'day') return null;
  const off = typeof q.tzOffsetMinutes === 'number' && Number.isFinite(q.tzOffsetMinutes) ? Math.max(-840, Math.min(840, Math.round(q.tzOffsetMinutes))) : 0;
  return { from, to, bucket: q.bucket, tzOffsetMinutes: off };
}
