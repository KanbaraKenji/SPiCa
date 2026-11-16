// Local HTML in the built-in browser, scripts and all: served through the browser's own scheme
// (spica-page://<token>/<path>), only to the browser's session. A file opened from a conversation may read the
// files in its folder and below (read only: GET, nothing written), so a page split into several files works; a
// page drawn from an answer is only its own text. Each token is random and lasts while its page is open (the panel
// gives it back when the file is closed); nothing outside those folders can be reached.
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { BROWSER_FILE_SCHEME } from './policy';

type Entry = { kind: 'folder'; folder: string; entry: string } | { kind: 'text'; name: string; text: string };

/** `root`: the page's folder (a file is served only if its real path, links followed, is still under it). */
export type Served = { kind: 'file'; path: string; root: string } | { kind: 'text'; text: string } | { kind: 'none' };

/** The file name as it goes into the address (its folder is the token). */
function encodeName(name: string): string {
  return name
    .split(/[\\/]/)
    .map((p) => encodeURIComponent(p))
    .join('/');
}

export class LocalPages {
  readonly #entries = new Map<string, Entry>();
  readonly #token: () => string;

  constructor(token: () => string = () => randomBytes(16).toString('hex')) {
    this.#token = token;
  }

  /** A local HTML file: its address in the browser. The file's folder and what is under it can be read. */
  addFile(path: string): string {
    const full = resolve(path);
    const token = this.#token();
    this.#entries.set(token, { kind: 'folder', folder: dirname(full), entry: basename(full) });
    return `${BROWSER_FILE_SCHEME}://${token}/${encodeName(basename(full))}`;
  }

  /** A page drawn from an answer (its own text, nothing else to read). */
  addText(name: string, text: string): string {
    const token = this.#token();
    this.#entries.set(token, { kind: 'text', name, text });
    return `${BROWSER_FILE_SCHEME}://${token}/index.html`;
  }

  /** The page is closed: its address stops working. */
  release(url: string): void {
    try {
      this.#entries.delete(new URL(url).host);
    } catch {
      // not an address of ours
    }
  }

  /** What an address of the scheme serves: a file inside the page's folder, the page's own text, or nothing. */
  resolve(url: string, method = 'GET'): Served {
    if (method !== 'GET' && method !== 'HEAD') return { kind: 'none' };
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { kind: 'none' };
    }
    if (u.protocol !== `${BROWSER_FILE_SCHEME}:`) return { kind: 'none' };
    const e = this.#entries.get(u.host);
    if (!e) return { kind: 'none' };
    let rel: string;
    try {
      rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    } catch {
      return { kind: 'none' };
    }
    if (e.kind === 'text') return rel === 'index.html' ? { kind: 'text', text: e.text } : { kind: 'none' };
    if (!rel || rel.includes('\0')) return { kind: 'none' };
    const full = resolve(e.folder, rel);
    const inside = relative(e.folder, full);
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('..')) return { kind: 'none' };
    return { kind: 'file', path: full, root: e.folder };
  }
}

/** Whether a file is under a folder once links (symbolic links, junctions) are followed on both. */
export async function realInside(path: string, root: string, real: (p: string) => Promise<string> = (p) => realpath(p)): Promise<boolean> {
  try {
    const [file, base] = await Promise.all([real(path), real(root)]);
    const inside = relative(base, file);
    return Boolean(inside) && !inside.startsWith('..') && !isAbsolute(inside);
  } catch {
    return false;
  }
}
