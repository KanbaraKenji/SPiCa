// Small helpers shared by the extractors: local timestamps, page ranges, size budget.
import { ExtractError } from './types.ts';

/** ISO 8601 in local time with offset, e.g. 2026-11-09T15:20:42.988+08:00 (same form as the kernel). */
export function isoLocal(d: Date = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Parse "3", "2-5", "1,4,7-9" into sorted unique 1-based numbers within 1..max.
 * Numbers beyond max are dropped; a range with nothing left is an error the model can fix.
 */
export function parseRanges(spec: string, max: number, unit: string): number[] {
  const out = new Set<number>();
  for (const raw of spec.split(/[,，\s]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d+)(?:\s*[-–~]\s*(\d+))?$/.exec(part);
    if (!m) throw new ExtractError(`Invalid ${unit} range "${part}". Use forms like "3", "2-5" or "1,4,7-9".`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    const lo = Math.max(1, Math.min(a, b));
    const hi = Math.min(max, Math.max(a, b));
    for (let i = lo; i <= hi; i++) out.add(i);
  }
  if (out.size === 0) throw new ExtractError(`No ${unit}s in "${spec}"; the file has ${max} ${unit}${max === 1 ? '' : 's'}.`);
  return [...out].sort((x, y) => x - y);
}

/** [1,2,3,5,7,8] -> "1-3,5,7-8" */
export function formatRanges(nums: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++;
    parts.push(i === j ? String(nums[i]) : `${nums[i]}-${nums[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}

/** Tracks how many characters a result may still take. */
export class Budget {
  #left: number;
  constructor(max: number) {
    this.#left = max;
  }
  get left(): number {
    return this.#left;
  }
  fits(s: string): boolean {
    return s.length <= this.#left;
  }
  take(s: string): boolean {
    if (s.length > this.#left) return false;
    this.#left -= s.length;
    return true;
  }
}

/** Excel-style column letters: 1 -> A, 27 -> AA. */
export function colName(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "AB12" -> { col: 28, row: 12 } */
export function parseCellRef(ref: string): { col: number; row: number } | undefined {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref);
  if (!m) return undefined;
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExtractError('Aborted.');
}

/** Collapse runs of spaces/tabs and trim; keeps the text on one line. */
export function oneLine(s: string): string {
  return s.replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}
