// File preview for the right panel: what kind a file is, its text (capped), or
// a private URL (spica-file://) for the built-in PDF viewer and images. Only
// files the user asked to preview get a URL; nothing else is reachable.
import { randomUUID } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { PreviewInfo } from '../shared/bridge';
import { EXCEL, officePreview, WORD } from './office-preview';

export const PREVIEW_SCHEME = 'spica-file';
/** Text beyond this is not shown (the panel says so and offers the system program). */
export const TEXT_LIMIT = 512 * 1024;

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);
const MARKDOWN = new Set(['.md', '.markdown']);
const HTML = new Set(['.html', '.htm']);
const TEXT = new Set([
  '.txt', '.log', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.toml', '.env.example',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb', '.php',
  '.sh', '.ps1', '.bat', '.cmd', '.sql', '.css', '.scss', '.less', '.vue', '.svelte', '.kt', '.swift', '.m', '.r', '.lua', '.pl', '.vb', '.bas',
]);

export type PreviewKind = PreviewInfo['kind'];

export function kindOf(path: string): Exclude<PreviewKind, 'missing' | 'sheet'> {
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (IMAGE.has(ext)) return 'image';
  if (MARKDOWN.has(ext)) return 'markdown';
  if (HTML.has(ext)) return 'html';
  if (TEXT.has(ext) || ext === '') return 'text';
  return 'unsupported';
}

/** UTF-8, or GB18030 when UTF-8 does not fit (Chinese text files saved by older Windows tools). */
export function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad === 0 || bad < utf8.length / 200) return utf8;
  try {
    return new TextDecoder('gb18030').decode(bytes);
  } catch {
    return utf8;
  }
}

/** Paths given out as spica-file://<token>; a token only ever maps to the one file. */
export class PreviewFiles {
  readonly #byToken = new Map<string, string>();

  urlFor(path: string): string {
    for (const [t, p] of this.#byToken) if (p === path) return `${PREVIEW_SCHEME}://f/${t}`;
    const token = randomUUID();
    this.#byToken.set(token, path);
    if (this.#byToken.size > 200) this.#byToken.delete(this.#byToken.keys().next().value as string);
    return `${PREVIEW_SCHEME}://f/${token}`;
  }

  /** The file behind a spica-file URL, or undefined. */
  pathOf(url: string): string | undefined {
    try {
      const u = new URL(url);
      return this.#byToken.get(u.pathname.replace(/^\/+/, ''));
    } catch {
      return undefined;
    }
  }
}

/** `sheet`: which sheet of an Excel workbook (1-based; the first when absent). */
export async function readPreview(path: string, files: PreviewFiles, sheet?: number): Promise<PreviewInfo> {
  const name = basename(path);
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) return { kind: 'unsupported', name, path, size: 0, message: '不是文件' };
    size = st.size;
  } catch {
    return { kind: 'missing', name, path, size: 0, message: '找不到文件，可能已被移动或删除。' };
  }
  const ext = extname(path).toLowerCase();
  if (WORD.has(ext) || EXCEL.has(ext)) return officePreview(path, name, size, ext, sheet);
  const kind = kindOf(path);
  if (kind === 'pdf' || kind === 'image') {
    // An SVG is text too: its source comes along for the panel's 代码 view.
    const svg = kind === 'image' && extname(path).toLowerCase() === '.svg' && size <= TEXT_LIMIT ? await readFile(path, 'utf8').catch(() => undefined) : undefined;
    return { kind, name, path, size, url: files.urlFor(path), ...(svg !== undefined ? { text: svg } : {}) };
  }
  if (kind === 'unsupported') return { kind, name, path, size, message: '不支持预览此类文件。' };
  const handle = await open(path, 'r');
  try {
    const length = Math.min(size, TEXT_LIMIT);
    const buf = new Uint8Array(length);
    await handle.read(buf, 0, length, 0);
    return { kind, name, path, size, text: decodeText(buf), truncated: size > TEXT_LIMIT };
  } finally {
    await handle.close();
  }
}
