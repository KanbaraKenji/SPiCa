// Word and Excel in the right panel, read with @spica/extract (the core reads them the same way for the model):
// a Word document as Markdown (headings, lists, tables), an Excel sheet as a grid with Excel's row numbers and
// column letters. Neither shows fonts, colours or pictures: a plugin preview page can (设置 › 常规 › 文件预览),
// and 用系统程序打开 is always there.
import { stat, readFile } from 'node:fs/promises';
import { colName, extractFile, SheetBook } from '@spica/extract';
import type { PreviewInfo } from '../shared/bridge';
import { t } from '../shared/i18n';

export const WORD = new Set(['.docx', '.docm']);
export const EXCEL = new Set(['.xlsx', '.xlsm']);
/** Blocks of a document shown at most; rows of a sheet sent at a time (the panel asks for more as it scrolls). */
const ROWS = 500;
/** Characters of one sheet kept in memory; a sheet beyond it shows its first rows and says so. */
const SHEET_KEEP_CHARS = 20_000_000;
/** Workbooks kept open (the last ones shown): going back to a sheet or paging reads nothing again. */
const BOOKS = 2;
/** A workbook bigger than this is not opened (as the model's reader). */
const BOOK_MAX_BYTES = 200 * 1024 * 1024;

const books = new Map<string, SheetBook>();

/** The workbook at `path` as it is now: kept while the file is unchanged (same size and modification time). */
async function bookFor(path: string): Promise<SheetBook> {
  const st = await stat(path);
  const key = `${path}|${st.size}|${st.mtimeMs}`;
  let book = books.get(key);
  if (book) books.delete(key);
  else {
    if (st.size > BOOK_MAX_BYTES) throw new Error('too large');
    for (const k of books.keys()) if (k.startsWith(`${path}|`)) books.delete(k);
    book = new SheetBook(new Uint8Array(await readFile(path)), SHEET_KEEP_CHARS);
  }
  books.set(key, book);
  while (books.size > BOOKS) books.delete(books.keys().next().value as string);
  return book;
}

/** What the panel says for a file it cannot read (the error from stat, open or the extractor; here as preview.ts needs it too). */
export function unreadable(err: unknown): { kind: 'missing' | 'unsupported'; message: string } {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing', message: t('找不到文件，可能已被移动或删除。') };
  if (code === 'EACCES' || code === 'EPERM') return { kind: 'unsupported', message: t('没有权限读取此文件。') };
  return { kind: 'unsupported', message: t('无法读取此文件。') };
}

/** The extractor's numbered blocks ("[3] text", tables indented under "[8] Table 1 (…):") as plain Markdown. */
export function docxMarkdown(text: string): string {
  const out: string[] = [];
  let started = false;
  for (const line of text.split('\n')) {
    const block = /^\[\d+\] (.*)$/.exec(line);
    if (block) {
      started = true;
      if (/^Table \d+ \(/.test(block[1]!)) continue;
      // List items stay together; everything else is a paragraph of its own.
      const item = /^(- |\d+\. )/;
      if (!(item.test(block[1]!) && item.test(out[out.length - 1] ?? ''))) out.push('');
      out.push(block[1]!);
      continue;
    }
    if (!started) continue;
    if (/^ {4}\|/.test(line)) {
      if (!out[out.length - 1]?.startsWith('|')) out.push('');
      out.push(line.slice(4));
      continue;
    }
    if (/^\[Stopped|^Headings not shown/.test(line)) break;
  }
  return out.join('\n').trim();
}

/**
 * A Word or Excel file as the panel shows it; `sheet`: which sheet of a workbook (1-based), `from`: its rows from
 * this row number on (the next page as the panel scrolls).
 */
export async function officePreview(path: string, name: string, size: number, ext: string, sheet = 1, from = 1): Promise<PreviewInfo> {
  try {
    if (WORD.has(ext)) {
      const r = await extractFile(path, { limit: ROWS });
      // The extractor stops at ROWS blocks or at its size limit, whichever comes first; it reports which it showed.
      const total = r.meta.blockCount ?? 0;
      const shown = Number(/-(\d+)$/.exec(r.meta.read?.blocks ?? '')?.[1] ?? total);
      const cut = shown < total || Boolean(r.truncated);
      return { kind: 'markdown', name, path, size, text: docxMarkdown(r.text), truncated: cut, ...(cut ? { blocks: { shown, total } } : {}) };
    }
    return sheetPage(await bookFor(path), name, path, size, sheet, from);
  } catch (err) {
    return { ...unreadable(err), name, path, size };
  }
}

/** One page of a sheet: up to ROWS rows with content from row `from` on, and whether more follow. */
export function sheetPage(book: SheetBook, name: string, path: string, size: number, sheet: number, from: number): PreviewInfo {
  const index = Math.min(Math.max(1, sheet), book.sheets.length) - 1;
  const g = book.grid(index);
  // The first row at or after `from` (the rows are sorted by number).
  let lo = 0;
  let hi = g.rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (g.rows[mid]![0] < from) lo = mid + 1;
    else hi = mid;
  }
  const page = g.rows.slice(lo, lo + ROWS);
  const columns = Array.from({ length: g.maxCol }, (_, i) => colName(i + 1));
  return {
    kind: 'sheet',
    name,
    path,
    size,
    sheets: book.sheets.map((s) => ({ name: s.name })),
    sheet: index + 1,
    columns,
    rows: page.map(([n, cells]) => ({ n, cells })),
    more: lo + ROWS < g.rows.length,
    // Rows never shown, however far it scrolls: the sheet was too big to keep whole.
    ...(g.clipped ? { left: { shown: g.rows.length, total: g.rowCount } } : {}),
  };
}
