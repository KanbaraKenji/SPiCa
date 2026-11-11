// Paths the window hands to Explorer and the clipboard.

/**
 * A path as Explorer and the clipboard want it: absolute, with the conversation's working folder in front of a
 * relative one (the model may have written a tool's path relative to it), `.` and `..` resolved, Windows
 * separators when the folder uses them. Unchanged when it is relative and there is no folder.
 */
export function fullPath(path: string, cwd?: string): string {
  const absolute = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path);
  if (absolute && !/(^|[\\/])\.\.?([\\/]|$)/.test(path)) return path;
  if (!absolute && !cwd) return path;
  const base = absolute ? path : cwd!;
  const win = /^[A-Za-z]:|^\\\\/.test(base) || base.includes('\\');
  const joined = absolute ? path : `${base.replace(/[\\/]+$/, '')}/${path}`;
  const sep = win ? '\\' : '/';
  const head = /^(?:[A-Za-z]:|\\\\[^\\/]+[\\/][^\\/]+|)/.exec(joined)![0];
  const parts: string[] = [];
  for (const p of joined.slice(head.length).split(/[\\/]+/)) {
    if (!p || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return `${head.replace(/\//g, sep)}${sep}${parts.join(sep)}`;
}
