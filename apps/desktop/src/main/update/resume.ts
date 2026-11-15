// Back where it was after an update: before the installer runs, the open conversation is written down; the
// new version reads it once at start (and removes it), so its window opens that conversation again.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

/** A note older than this is not used (the update did not go through, and the app was started much later). */
export const RESUME_FOR_MS = 60 * 60_000;

export interface Resume {
  sessionId: string | null;
}

export function writeResume(file: string, r: Resume, now: number = Date.now()): void {
  try {
    writeFileSync(file, JSON.stringify({ sessionId: r.sessionId, at: now }));
  } catch {
    // Without it the new version opens as it would anyway.
  }
}

/** The note left before an update, once: it is removed whether it is used or not. */
export function readResume(file: string, now: number = Date.now()): Resume | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  } finally {
    try {
      rmSync(file, { force: true });
    } catch {
      // Read again next time; it is too old by then.
    }
  }
  const v = raw && typeof raw === 'object' ? (raw as { sessionId?: unknown; at?: unknown }) : {};
  if (typeof v.at !== 'number' || now - v.at > RESUME_FOR_MS || now < v.at) return null;
  return { sessionId: typeof v.sessionId === 'string' && v.sessionId ? v.sessionId : null };
}
