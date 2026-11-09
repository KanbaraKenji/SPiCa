// The file being read: bytes plus the facts every card needs.
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { ExtractError, type FileCardMeta, type FileKind } from './types.ts';
import { humanSize, isoLocal } from './util.ts';

export interface SourceFile {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  extractedAt: string;
  bytes: Uint8Array;
  metaBase(kind: FileKind): Omit<FileCardMeta, 'read'> & { read: FileCardMeta['read'] };
}

export async function loadSource(path: string, maxBytes: number): Promise<SourceFile> {
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new ExtractError(`File not found: ${path}`);
  if (info.isDirectory()) throw new ExtractError(`${path} is a folder; use list_dir.`);
  if (info.size > maxBytes) {
    throw new ExtractError(`${basename(path)} is ${humanSize(info.size)}, over the ${humanSize(maxBytes)} limit for extraction.`);
  }
  const bytes = new Uint8Array(await readFile(path));
  const extractedAt = isoLocal();
  const modifiedAt = isoLocal(info.mtime);
  const name = basename(path);
  return {
    path,
    name,
    size: info.size,
    modifiedAt,
    extractedAt,
    bytes,
    metaBase: (kind) => ({ path, name, kind, sizeBytes: info.size, modifiedAt, extractedAt, read: {} }),
  };
}
