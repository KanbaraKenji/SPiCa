// The file card for a file a call made (an MCP tool's download, a command's
// output): what kind it is, how big, when it changed. Read files get theirs from
// read_file and the extractors, which also say what part was read.
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { isoNow } from '../events.ts';
import type { FileCardMeta } from '../types.ts';

const KIND: Record<string, FileCardMeta['kind']> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.pptx': 'pptx',
};
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
  return {
    path,
    name: basename(path),
    kind: fileCardKind(path),
    sizeBytes: info.size,
    modifiedAt: isoNow(info.mtime),
    extractedAt: isoNow(),
    read: {},
    origin,
  };
}
