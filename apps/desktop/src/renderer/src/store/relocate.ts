// Where a file named in a conversation is now. Choosing the working folder (once) moves what the
// conversation had made into the new folder, renaming the ones whose name was taken; or, for a
// conversation from 0.1.0-rc.2, leaves them in the folder all conversations shared then. Paths
// written before that note mean the folder of that time, so file cards, the 文件 list, the preview
// and 用系统程序打开 look there (or at the new name), never at a same-named file in the new folder.
import type { CwdChangeMeta } from '@spica/protocol';

const isAbsolute = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');

/** Compared the way Windows and macOS file systems do: either separator, any case. */
const key = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function join(dir: string, rel: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  const tail = sep === '\\' ? rel.replace(/\//g, '\\') : rel.replace(/\\/g, '/');
  return dir.replace(/[\\/]+$/, '') + sep + tail.replace(/^[\\/]+/, '');
}

/** `full` inside `dir`: the part after it (as written in `full`), else null. */
function inside(full: string, dir: string): string | null {
  const d = key(dir) + '/';
  return key(full).startsWith(d) ? full.slice(dir.replace(/[\\/]+$/, '').length + 1) : null;
}

/**
 * The path to open for `path` (as the core or the model wrote it) in a message before the
 * working-folder note `change`. Without a change the path is left as it is (it means the
 * conversation's folder now). A file that was in the old folder but is not among the moved ones
 * keeps its old full path, which no longer exists: opening it says it cannot be found.
 */
export function relocate(path: string, change: CwdChangeMeta | undefined): string {
  if (!change || !path) return path;
  if (change.filesStayIn) return isAbsolute(path) ? path : join(change.filesStayIn, path);
  const old = isAbsolute(path) ? path : join(change.from, path);
  const rel = inside(old, change.from);
  if (rel === null) return path;
  const renamed = (change.renamed ?? []).find((r) => key(r.from) === key(rel));
  if (renamed) return join(change.to, renamed.to);
  const moved = (change.moved ?? []).find((m) => key(m.from) === key(rel));
  return moved ? join(change.to, moved.to) : old;
}

/** For each response, the working-folder change that came after it (there is at most one). */
export function changesAfter<T extends { kind: string; id: string; cwd?: CwdChangeMeta }>(items: readonly T[]): Map<string, CwdChangeMeta> {
  const out = new Map<string, CwdChangeMeta>();
  let after: CwdChangeMeta | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'note' && it.cwd) after = it.cwd;
    else if (it.kind === 'response' && after) out.set(it.id, after);
  }
  return out;
}

/** The same folder, the way Windows and macOS compare paths (either separator, any case, no trailing one). */
export function sameFolder(a: string, b: string | undefined): boolean {
  return Boolean(a && b) && key(a) === key(b!);
}

/**
 * What to show for a relocated file: moved into the conversation's folder, its path inside that folder (as files
 * written there are shown, without the folder); otherwise the path to open itself.
 */
export function shownPath(open: string, change: CwdChangeMeta | undefined): string {
  if (!change || change.filesStayIn) return open;
  return inside(open, change.to) ?? open;
}
