// Where a conversation may write without asking: its working folder, its project's folder, the folders and
// files the user gave it themselves (typed in their own message, attached, or allowed on a card), and those of the
// conversation that started it (a sub-agent works within its parent's). A write anywhere else is confirmed
// (GuardCause 'outside_folder'), in either approval mode.
//
// Paths are compared as the file system sees them: a junction or symbolic link inside the folder that points
// out counts as out; `..`, 8.3 short names and letter case (Windows, macOS) do not change the answer.
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * The real path of `p` (absolute), as far as it exists: the nearest existing ancestor is resolved through
 * links and short names, the rest (not made yet) appended. Case-folded where the file system ignores case.
 */
export function canonicalPath(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(head);
      const out = tail.length ? join(real, ...tail.reverse()) : real;
      return fold(out);
    } catch {
      const up = dirname(head);
      if (up === head) return fold(resolve(p));
      tail.push(basename(head));
      head = up;
    }
  }
}

function fold(p: string): string {
  const trimmed = p.length > 3 && p.endsWith(sep) ? p.slice(0, -1) : p;
  return FOLD_CASE ? trimmed.toLowerCase() : trimmed;
}

/** `p` is `root` or inside it (both canonical). */
export function within(p: string, root: string): boolean {
  if (p === root) return true;
  const base = root.endsWith(sep) ? root : root + sep;
  return p.startsWith(base);
}

/** Whether `target` (absolute) is inside any of `roots` (absolute, any form). */
export function inScope(target: string, roots: readonly string[]): boolean {
  const t = canonicalPath(target);
  return roots.some((r) => within(t, canonicalPath(r)));
}

// A drive path (C:\… or C:/…) or a network path (\\server\share\…), up to whitespace, quotes or Chinese
// punctuation; a path written in quotes may hold spaces.
const QUOTED = /["“”「『]((?:[A-Za-z]:[\\/]|\\\\)[^"“”」』\r\n]+)["“”」』]/g;
const BARE = /(?:^|[\s(（:：,，])((?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/])[^\s"'<>|*?「」『』（）()，。、；;：]*)/g;
const POSIX = /(?:^|[\s(（:：,，])(\/(?:[^\s/"'<>|*?「」『』（）()，。、；;：]+\/?)+)/g;

/**
 * The absolute paths written in a message the user typed. Only absolute ones: a relative path means the
 * working folder already. Trailing dots and commas are not part of the path.
 */
export function pathsInText(text: string): string[] {
  const out = new Set<string>();
  const add = (p: string | undefined) => {
    const s = p?.trim().replace(/[.,。，、]+$/, '');
    if (s && isAbsolute(s) && s.length > 3) out.add(s);
  };
  for (const m of text.matchAll(QUOTED)) add(m[1]);
  for (const m of text.matchAll(BARE)) add(m[1]);
  if (process.platform !== 'win32') for (const m of text.matchAll(POSIX)) add(m[1]);
  return [...out];
}
