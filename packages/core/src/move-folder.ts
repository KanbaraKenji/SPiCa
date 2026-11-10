// Moving what a conversation made in its own folder into the folder the user
// chose: all or nothing. Every file keeps its path relative to the folder;
// where a file of that name is already there, the moved one gets " (1)",
// " (2)", ... before its extension (nothing is overwritten). When a move
// fails, the files moved so far go back and the folders made for them are
// removed again. Synchronous on purpose: nothing else in the process can
// write into the folder while it runs.
import { copyFileSync, constants, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';

export interface MovePlanItem {
  /** Relative to the source folder. */
  from: string;
  /** Relative to the target folder (differs from `from` when renamed). */
  to: string;
}

export type MoveResult =
  | { ok: true; moved: MovePlanItem[]; renamed: MovePlanItem[] }
  | { ok: false; file: string; message: string; notRestored: string[] };

/** Move one file; across drives copy (never over an existing file) and delete the source. */
export function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    unlinkSync(from);
  }
}

/** Every file and folder under `root`, relative, folders before what is in them. */
function walk(root: string): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  const visit = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        dirs.push(r);
        visit(r);
      } else files.push(r);
    }
  };
  if (existsSync(root)) visit('');
  return { files, dirs };
}

// file names that differ only in case are the same file on Windows and macOS
const fold = process.platform === 'win32' || process.platform === 'darwin' ? (r: string) => r.toLowerCase() : (r: string) => r;

/** The first free name for `rel` in `dest`: rel itself, else "name (1).ext", "name (2).ext", ... */
function freeName(dest: string, rel: string, taken: Set<string>): string {
  const free = (r: string) => !taken.has(fold(r)) && !existsSync(join(dest, r));
  if (free(rel)) return rel;
  const ext = extname(rel);
  const base = rel.slice(0, rel.length - ext.length);
  for (let n = 1; ; n++) {
    const r = `${base} (${n})${ext}`;
    if (free(r)) return r;
  }
}

/** Make a folder and its missing parents; returns the ones it made (outermost first). */
function makeDirs(dir: string): string[] {
  const missing: string[] = [];
  for (let d = dir; !existsSync(d); d = dirname(d)) {
    missing.unshift(d);
    if (dirname(d) === d) break;
  }
  if (missing.length) mkdirSync(dir, { recursive: true });
  return missing;
}

export function moveFolderContents(src: string, dest: string, move: (from: string, to: string) => void = moveFile): MoveResult {
  const { files, dirs } = walk(src);
  const taken = new Set<string>();
  const plan: MovePlanItem[] = files.map((from) => {
    const to = freeName(dest, from, taken);
    taken.add(fold(to));
    return { from, to };
  });
  const done: MovePlanItem[] = [];
  const made: string[] = [];
  let failed: { file: string; message: string } | undefined;
  try {
    made.push(...makeDirs(dest));
    for (const d of dirs) made.push(...makeDirs(join(dest, d))); // empty folders come along too
  } catch (err) {
    failed = { file: '', message: err instanceof Error ? err.message : String(err) };
  }
  for (const item of failed ? [] : plan) {
    try {
      made.push(...makeDirs(dirname(join(dest, item.to))));
      move(join(src, item.from), join(dest, item.to));
      done.push(item);
    } catch (err) {
      failed = { file: item.from, message: err instanceof Error ? err.message : String(err) };
      break;
    }
  }
  if (!failed) {
    return { ok: true, moved: plan, renamed: plan.filter((p) => p.from !== p.to) };
  }
  // back to how it was: the moved files return, the folders made for them go
  const notRestored: string[] = [];
  for (const item of done.reverse()) {
    try {
      makeDirs(dirname(join(src, item.from)));
      move(join(dest, item.to), join(src, item.from));
    } catch {
      notRestored.push(item.from);
    }
  }
  for (const d of made.reverse()) {
    try {
      rmdirSync(d); // only when empty
    } catch {
      // something else is in it: leave it
    }
  }
  return { ok: false, ...failed, notRestored };
}

/** Remove a folder tree that holds no files any more (after everything was moved out). */
export function removeEmptyTree(root: string): boolean {
  const { files, dirs } = walk(root);
  if (files.length) return false;
  for (const d of dirs.reverse()) rmdirSync(join(root, d));
  rmdirSync(root);
  return true;
}

/** `child` is `parent` or inside it. */
export function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel) && !rel.startsWith('/') && !rel.startsWith('\\'));
}
