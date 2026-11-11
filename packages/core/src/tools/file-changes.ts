// What changed in a folder while a command ran (new and modified files), and
// how many lines a write added and removed. The window shows these as file
// cards; the model gets one line naming them.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileCardMeta } from '../types.ts';
import { producedFileCard } from './file-card.ts';

/** More files than this in the folder: changes are not tracked (the walk would slow every command down). */
export const SNAPSHOT_MAX_FILES = 20_000;
/** At most this many cards for one command; the rest are counted in the result. */
export const MAX_CHANGE_CARDS = 20;
/** Files larger than this get no line counts (the old content would have to be read and compared). */
export const LINE_COUNT_MAX_BYTES = 2_000_000;

/**
 * Folders and files that change as a side effect (package caches, version control, Python byte code, editor and
 * Office lock files, system thumbnails): never reported as something a command made. The one list; tested.
 */
export const IGNORED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv', '.tox', '.cache', '.gradle', '.idea', '.vs']);
const IGNORED_FILE = /^(~\$.*|\.~lock\..*#|Thumbs\.db|desktop\.ini|\.DS_Store|.*\.(pyc|pyo|tmp|swp|swo))$/i;

export function ignoredFile(name: string): boolean {
  return IGNORED_FILE.test(name);
}

/** Listing the folder takes longer than this (a network or synced drive): changes are not tracked. */
export const SNAPSHOT_MAX_MS = 1000;

export interface FolderSnapshot {
  root: string;
  /** Absolute path to size and modification time (ms). */
  files: Map<string, { size: number; mtimeMs: number }>;
  /** No snapshot: the folder has more files than the limit, or listing it took longer than the limit. */
  skipped?: 'too_many' | 'too_slow';
}

export interface SnapshotLimits {
  maxFiles?: number;
  maxMs?: number;
  /** Clock in milliseconds (replaceable for tests). */
  now?: () => number;
}

/** How many folders are listed, and files looked at, at the same time. */
const PARALLEL = 64;

/**
 * Every file under `root` (ignored folders and files left out), or why not (`skipped`). Names are listed first
 * (cheap), so a folder over the limit is given up on early; then sizes and times are read in parallel. The clock is
 * checked after every batch, so a slow drive is given up on after about `maxMs`. Unreadable entries are skipped.
 */
export async function snapshotFolder(root: string, limits: SnapshotLimits = {}): Promise<FolderSnapshot> {
  const max = limits.maxFiles ?? SNAPSHOT_MAX_FILES;
  const maxMs = limits.maxMs ?? SNAPSHOT_MAX_MS;
  const now = limits.now ?? (() => performance.now());
  const t0 = now();
  const skip = (why: 'too_many' | 'too_slow'): FolderSnapshot => ({ root, files: new Map(), skipped: why });
  const paths: string[] = [];
  let level = [root];
  while (level.length > 0) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += PARALLEL) {
      const listed = await Promise.all(level.slice(i, i + PARALLEL).map((d) => readdir(d, { withFileTypes: true }).then((es) => es.map((e) => [d, e] as const), () => [])));
      for (const [dir, e] of listed.flat()) {
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name)) next.push(join(dir, e.name));
        } else if (e.isFile() && !ignoredFile(e.name)) {
          paths.push(join(dir, e.name));
          if (paths.length > max) return skip('too_many');
        }
      }
      if (now() - t0 > maxMs) return skip('too_slow');
    }
    level = next;
  }
  const files = new Map<string, { size: number; mtimeMs: number }>();
  for (let i = 0; i < paths.length; i += PARALLEL) {
    const stats = await Promise.all(paths.slice(i, i + PARALLEL).map((p) => stat(p).catch(() => undefined)));
    stats.forEach((st, k) => {
      if (st) files.set(paths[i + k]!, { size: st.size, mtimeMs: st.mtimeMs });
    });
    if (now() - t0 > maxMs) return skip('too_slow');
  }
  return { root, files };
}

/** Why changes were not tracked, for the command's result (before: the listing before it ran; after: the one after). */
export function notTrackedLine(skipped: 'too_many' | 'too_slow', when: 'before' | 'after'): string {
  const why =
    skipped === 'too_many'
      ? `the folder has more than ${SNAPSHOT_MAX_FILES} files${when === 'after' ? ' now' : ''}`
      : `listing the folder ${when === 'after' ? 'after the command ' : ''}took more than ${SNAPSHOT_MAX_MS / 1000} s`;
  return `[changes in the folder not tracked: ${why}]`;
}

/** Files that are new in `after`, and files whose size or modification time changed; each sorted by path. */
export function folderChanges(before: FolderSnapshot, after: FolderSnapshot): { created: string[]; modified: string[] } {
  const created: string[] = [];
  const modified: string[] = [];
  for (const [path, a] of after.files) {
    const b = before.files.get(path);
    if (!b) created.push(path);
    else if (b.size !== a.size || b.mtimeMs !== a.mtimeMs) modified.push(path);
  }
  return { created: created.sort(), modified: modified.sort() };
}

/** Cards for what changed (created first), at most `MAX_CHANGE_CARDS`; files gone again in between are left out. */
export async function changeCards(changes: { created: string[]; modified: string[] }): Promise<FileCardMeta[]> {
  const out: FileCardMeta[] = [];
  const list = [...changes.created.map((p) => [p, 'created'] as const), ...changes.modified.map((p) => [p, 'modified'] as const)];
  for (const [path, origin] of list) {
    if (out.length >= MAX_CHANGE_CARDS) break;
    const card = await producedFileCard(path, origin);
    if (card) out.push(card);
  }
  return out;
}

function lines(text: string): string[] {
  if (text === '') return [];
  const all = text.replace(/\r\n/g, '\n').split('\n');
  if (all.at(-1) === '') all.pop(); // a final newline does not start another line
  return all;
}

/**
 * Lines added and removed between two versions of a text, counted as lines that appear more (or fewer) times than
 * before, order ignored: exact for appends, deletions and replacements, an estimate for moved lines (a moved line
 * counts as neither). Linear, so it stays cheap on large files.
 */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const count = new Map<string, number>();
  for (const l of lines(before)) count.set(l, (count.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of lines(after)) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed };
}

/** The old content of a file for line counts: undefined when it does not exist, is too large or is not text. */
export async function oldText(path: string): Promise<string | undefined> {
  const s = await stat(path).catch(() => undefined);
  if (!s?.isFile() || s.size > LINE_COUNT_MAX_BYTES) return undefined;
  const buf = await readFile(path).catch(() => undefined);
  if (!buf || buf.includes(0)) return undefined;
  return buf.toString('utf8');
}

/** Short list of changed files for the model: paths relative to the folder where they are inside it. */
export function changeLine(changes: { created: string[]; modified: string[] }, show: (abs: string) => string): string {
  const part = (label: string, list: string[]) => (list.length ? `${label} ${list.slice(0, MAX_CHANGE_CARDS).map(show).join(', ')}${list.length > MAX_CHANGE_CARDS ? ` and ${list.length - MAX_CHANGE_CARDS} more` : ''}` : '');
  const parts = [part('created', changes.created), part('modified', changes.modified)].filter(Boolean);
  return parts.length ? `[changed in the folder while the command ran (other programs may have changed some too): ${parts.join('; ')}]` : '';
}
