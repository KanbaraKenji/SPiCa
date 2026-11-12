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

// Where a path written in plain text ends: whitespace, what Windows forbids in a path, and punctuation (Chinese
// and ASCII; brackets too, though a file name may hold them: such a path is then left as it is).
const PLAIN_STOP = /[\s<>"|?*:，。；：、！？（）【】「」『』《》“”‘’,;!?()[\]{}]/;
// A path is not taken from inside a word, a web address or another path.
const PLAIN_BEFORE = /[A-Za-z0-9_\-.\\/:%@&=+~$#]/;
// A file's last part: a name, then an extension with a letter in it; after it only nothing, or a non-ASCII
// character (在 D:\a\报价.xlsx里 ends at .xlsx).
const PLAIN_FILE = /^(.+\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*)(?![A-Za-z0-9])(.*)$/;

/**
 * Full local paths written in plain text, where they start and end. Cautious: a path is taken only when its end
 * is certain, so one that is left out stays text and none is cut wrong. It starts with a drive (C:\ or C:/) or
 * \\server\share, not right after a letter, digit or a web address's characters; it ends at a space, a quote or
 * punctuation, a full stop after it not included, and must end as a folder (a separator) or a file with an
 * extension. Left as text: a name with a space (D:\My Files\a.txt) or a bracket in it, a last part with no
 * extension, ASCII straight after the extension (a.txt_old), and a path followed by a space and more path.
 */
export function findPlainPaths(text: string): { start: number; end: number; path: string }[] {
  const found: { start: number; end: number; path: string }[] = [];
  const head = /[A-Za-z]:[\\/]|\\\\(?=[^\\/\s])/g;
  for (let m = head.exec(text); m; m = head.exec(text)) {
    const start = m.index;
    let end = start + m[0].length;
    while (end < text.length && !PLAIN_STOP.test(text[end]!)) end++;
    head.lastIndex = end;
    if (start > 0 && PLAIN_BEFORE.test(text[start - 1]!)) continue;
    while (end > start && text[end - 1] === '.') end--;
    let path = text.slice(start, end);
    if (!/[\\/]$/.test(path)) {
      const last = path.slice(path.search(/[^\\/]*$/));
      const file = PLAIN_FILE.exec(last);
      if (!file) continue;
      const rest = file[2]!;
      if (rest && rest.charCodeAt(0) <= 0x7f) continue;
      path = path.slice(0, path.length - rest.length);
      end = start + path.length;
    }
    // D:\a.b c\d.txt: the space may be part of the path.
    const next = /^ (\S+)/.exec(text.slice(end))?.[1];
    if (next && /[\\/]/.test(next) && !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(next)) continue;
    if (!localPathKind(path)) continue;
    found.push({ start, end, path });
    head.lastIndex = end;
  }
  return found;
}

/** The parts of a Markdown syntax node walked here. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/**
 * A step after Markdown is read: a full local path in plain text becomes inline code marked `data-plain` (shown
 * like a path in inline code, and as plain text where nothing opens it). `found` gets every path of the answer,
 * written either way, for pathLabel. Text in links and code blocks is left alone.
 */
export function remarkLocalPaths(found: string[]) {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
    node.children = node.children.flatMap((c): MdNode[] => {
      if (c.type === 'inlineCode' && c.value && localPathKind(c.value)) found.push(c.value);
      if (c.type !== 'text' || !c.value) {
        walk(c);
        return [c];
      }
      const hits = findPlainPaths(c.value);
      if (!hits.length) return [c];
      const parts: MdNode[] = [];
      let at = 0;
      for (const h of hits) {
        if (h.start > at) parts.push({ type: 'text', value: c.value.slice(at, h.start) });
        parts.push({ type: 'inlineCode', value: h.path, data: { hProperties: { dataPlain: true } } });
        found.push(h.path);
        at = h.end;
      }
      if (at < c.value.length) parts.push({ type: 'text', value: c.value.slice(at) });
      return parts;
    });
  };
  return () => (tree: MdNode) => {
    found.length = 0;
    walk(tree);
  };
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
