// Paths the page hands to Explorer: 打开所在文件夹 on a file card, a folder path clicked in an answer, and the
// CSV a table is exported to. The checks are here (pure, tested); main/index.ts does the opening and writing.
import { posix, win32 } from 'node:path';

export type PathKind = 'file' | 'folder' | null;

/**
 * Whether a path from the page may go to Explorer: it must be absolute (the page resolves a conversation's
 * relative paths before asking) and be there. `want: 'folder'` takes only a folder (a path clicked in an answer
 * that ends with a separator); `'any'` a file or a folder (it is shown selected in its folder).
 */
export function checkLocalPath(path: unknown, want: 'any' | 'folder', kindOf: (p: string) => PathKind): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof path !== 'string' || !path || path.length > 4096 || !(win32.isAbsolute(path) || posix.isAbsolute(path))) return { ok: false, error: '路径无效。' };
  const kind = kindOf(path);
  if (want === 'folder') return kind === 'folder' ? { ok: true, path } : { ok: false, error: `找不到文件夹：${path}` };
  return kind ? { ok: true, path } : { ok: false, error: `找不到文件：${path}` };
}

/** The file name a CSV export suggests: the page's name made safe for Windows, with .csv; 表格.csv when there is none. */
export function csvFileName(name: unknown): string {
  const base = (typeof name === 'string' ? name : '')
    .replace(/\.csv$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 80);
  return `${base || '表格'}.csv`;
}

/** What a CSV file holds: a byte-order mark first, so Excel reads it as UTF-8 (Chinese otherwise comes out garbled). */
export function csvFileText(text: string): string {
  return text.startsWith('﻿') ? text : `﻿${text}`;
}
