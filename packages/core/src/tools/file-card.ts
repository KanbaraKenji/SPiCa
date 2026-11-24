// The file card for a file a call made (an MCP tool's download, a command's
// output): what kind it is, how big, when it changed. Read files get theirs from
// read_file and the extractors, which also say what part was read.
import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { isoNow } from '../events.ts';
import { imageSize, sniffImage } from '../images.ts';
import type { FileCardMeta } from '../types.ts';

const KIND: Record<string, FileCardMeta['kind']> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.docm': 'docx',
  '.doc': 'docx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.xls': 'xlsx',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.pptx': 'pptx',
  '.pptm': 'pptx',
  '.ppt': 'pptx',
};

/** Files whose card says they are pictures, with their size. */
export const PICTURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/**
 * A picture's width and height from the start of the file (no decoding), for its card; undefined when the file is
 * not a picture that can be measured. A JPEG's size can sit after a large embedded thumbnail, so 256 KB are read.
 */
export async function pictureSize(path: string): Promise<{ width: number; height: number } | undefined> {
  let head: Buffer;
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
  if (head.length >= 26 && head.toString('latin1', 0, 2) === 'BM') {
    const dib = head.readUInt32LE(14);
    const size = dib === 12 ? { width: head.readUInt16LE(18), height: head.readUInt16LE(20) } : { width: Math.abs(head.readInt32LE(18)), height: Math.abs(head.readInt32LE(22)) };
    return size.width && size.height ? size : undefined;
  }
  const type = sniffImage(head);
  const size = type ? imageSize(head, type) : undefined;
  return size?.width && size.height ? size : undefined;
}
const TEXT = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.log', '.xml', '.yaml', '.yml', '.ini', '.toml', '.html', '.htm', '.sql', '.ps1', '.py', '.js', '.ts']);

/** The card kind for a file name: the six known ones, plain text, else `other`. */
export function fileCardKind(path: string): FileCardMeta['kind'] {
  const ext = extname(path).toLowerCase();
  return KIND[ext] ?? (TEXT.has(ext) ? 'text' : 'other');
}

/**
 * A card for a file a call made; undefined when `path` is not an existing file.
 * `origin`: created, modified, or produced (made, but not known which).
 */
export async function producedFileCard(path: string, origin: Exclude<NonNullable<FileCardMeta['origin']>, 'read'>): Promise<FileCardMeta | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const image = PICTURE_EXTENSIONS.has(extname(path).toLowerCase()) ? await pictureSize(path) : undefined;
  return {
    path,
    name: basename(path),
    kind: fileCardKind(path),
    sizeBytes: info.size,
    modifiedAt: isoNow(info.mtime),
    extractedAt: isoNow(),
    read: {},
    origin,
    ...(image ? { image } : {}),
  };
}

/**
 * The card for a file a tool's result carried that was not kept (an MCP tool's embedded file over the limit, not
 * base64, not writable, or from a call with no conversation): its name and why. `path` only tells the cards apart
 * (`<call id>/<n>/<name>`); no file is there.
 */
export function notSavedCard(path: string, reason: NonNullable<FileCardMeta['notSaved']>, bytes?: number): FileCardMeta {
  const now = isoNow();
  return { path, name: basename(path), kind: fileCardKind(path), sizeBytes: bytes ?? 0, modifiedAt: now, extractedAt: now, read: {}, origin: 'produced', notSaved: reason };
}
