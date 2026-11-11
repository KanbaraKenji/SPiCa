// Paths in an answer the window can open. The system prompt asks the model to write each file or folder as its
// full absolute path in inline code, a folder ending with a separator; inline code that is exactly such a path
// becomes clickable (a file opens in the right panel, a folder in Explorer). Anything else stays plain code.

// A drive (D:\ or D:/) or a share (\\server\share\), then no characters Windows forbids in a path.
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/:*?"<>|\r\n]+[\\/][^\\/:*?"<>|\r\n]+(?:[\\/]|$))[^:*?"<>|\r\n]*$/;

/** 'file' or 'folder' when the inline code is exactly an absolute local path; null otherwise. */
export function localPathKind(code: string): 'file' | 'folder' | null {
  if (code !== code.trim() || code.length > 1024 || !ABSOLUTE.test(code)) return null;
  return /[\\/]$/.test(code) || /^\\\\[^\\/]+[\\/][^\\/]+$/.test(code) ? 'folder' : 'file';
}

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
