// Paths in an answer the window can open. The system prompt asks the model to write each file or folder as its
// full absolute path in inline code, a folder ending with a separator; inline code that is exactly such a path
// becomes clickable (a file opens in the right panel, a folder in Explorer) and shows only its name (pathLabel).
// Anything else stays plain code.

// A drive (D:\ or D:/) or a share (\\server\share\), then no characters Windows forbids in a path.
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/:*?"<>|\r\n]+[\\/][^\\/:*?"<>|\r\n]+(?:[\\/]|$))[^:*?"<>|\r\n]*$/;

// Device paths (\\.\pipe\…, \\?\C:\…) are never paths to open.
const DEVICE = /^[\\/]{2}[?.][\\/]/;

/** 'file' or 'folder' when the inline code is exactly an absolute local path; null otherwise. */
export function localPathKind(code: string): 'file' | 'folder' | null {
  if (code !== code.trim() || code.length > 1024 || DEVICE.test(code) || !ABSOLUTE.test(code)) return null;
  return /[\\/]$/.test(code) || /^\\\\[^\\/]+[\\/][^\\/]+$/.test(code) ? 'folder' : 'file';
}

/** A path's parts after its root (D:\ or \\server\share\), and the root itself. */
function splitPath(path: string): { root: string; parts: string[] } {
  const root = /^(?:[A-Za-z]:[\\/]?|\\\\[^\\/]+[\\/][^\\/]+[\\/]?)/.exec(path)?.[0] ?? '';
  return { root, parts: path.slice(root.length).split(/[\\/]+/).filter(Boolean) };
}

/**
 * What a path in an answer shows: its file name, or a folder's name with the separator after it (报价\). A drive
 * or a share on its own shows whole. When another path in the same answer would show the same, the folders above
 * are added until the two differ (第一版\报价.xlsx, 第二版\报价.xlsx). `others`: every path in the answer.
 */
export function pathLabel(path: string, others: readonly string[] = []): string {
  const { parts } = splitPath(path);
  if (!parts.length) return path;
  const sep = path.includes('\\') ? '\\' : '/';
  const folder = /[\\/]$/.test(path);
  const key = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  const rivals = others.filter((o) => key(o) !== key(path)).map((o) => splitPath(o).parts.map((x) => x.toLowerCase()));
  const own = parts.map((x) => x.toLowerCase());
  let n = 1;
  // Grow from the name upwards while another path ends in the same parts.
  while (n < parts.length && rivals.some((r) => r.length >= n && r.slice(-n).join('\\') === own.slice(-n).join('\\'))) n++;
  const shown = n >= parts.length && rivals.some((r) => r.slice(-n).join('\\') === own.slice(-n).join('\\')) ? path.replace(/[\\/]+$/, '') : parts.slice(-n).join(sep);
  return folder ? `${shown}${sep}` : shown;
}

/** The inline code spans of an answer outside its code blocks (backticks of any length, as Markdown reads them). */
export function inlineCodeSpans(text: string): string[] {
  const outside = text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|$)|$)/gm, '');
  const spans: string[] = [];
  for (const m of outside.matchAll(/(?<!`)(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)/g)) {
    const body = m[2]!.replace(/\n/g, ' ');
    spans.push(/^ .*[^ ].* $/.test(body) ? body.slice(1, -1) : body);
  }
  return spans;
}

/** Whether `path` is `folder` or inside it (`..` resolved first; letters' case ignored, as on Windows). */
export function insideFolder(path: string, folder: string | undefined): boolean {
  if (!folder) return false;
  const norm = (p: string) => fullPath(p).replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();
  const f = norm(folder);
  const p = norm(path);
  return p === f || p.startsWith(`${f}\\`);
}

/**
 * Like localPathKind, for a path in an answer that a click would open. A network path (\\host\share\…) only
 * inside the conversation's working folder: opening one makes Windows connect to that host and send the user's
 * sign-in, and the answer's text may come from a web page or a mail that names a host of its own. Drive paths
 * (mapped network drives too) open wherever they are.
 */
export function openablePathKind(code: string, cwd: string | undefined): 'file' | 'folder' | null {
  const kind = localPathKind(code);
  if (!kind) return null;
  if (/^[\\/]{2}/.test(code) && !insideFolder(code, cwd)) return null;
  return kind;
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
