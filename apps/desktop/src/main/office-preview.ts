// Word and Excel in the right panel, read with @spica/extract (the core reads them the same way for the model):
// a Word document as Markdown (headings, lists, tables), an Excel sheet as a grid with Excel's row numbers and
// column letters. Neither shows fonts, colours or pictures: a plugin preview page can (设置 › 常规 › 文件预览),
// and 用系统程序打开 is always there.
import { stat, readFile } from 'node:fs/promises';
import { colName, csvGrid, extractFile, SheetBook, sniffDelimiter, type Grid } from '@spica/extract';
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

/** A CSV file read whole and kept as a table, at most this big (a bigger one shows as text). */
export const CSV_MAX_BYTES = 50 * 1024 * 1024;
/** A CSV file's own text sent along for 查看代码, at most this many characters (as a text file). */
const CSV_TEXT_CHARS = 512 * 1024;

/** A workbook, or a CSV file as one: its sheets' names, and a sheet whole. */
interface Book {
  readonly sheets: readonly { name: string }[];
  grid(index: number): Grid;
  /** A CSV file's text (for 查看代码). */
  readonly text?: string;
}

/** A CSV file as a workbook of one sheet, named as the file. */
class CsvBook implements Book {
  readonly sheets: readonly { name: string }[];
  readonly text: string;
  readonly #delim: string;
  #grid: Grid | undefined;

  constructor(text: string, name: string, tsv: boolean) {
    this.text = text;
    this.sheets = [{ name: name.replace(/\.[^.]+$/, '') }];
    this.#delim = tsv ? '\t' : sniffDelimiter(text.slice(0, 64 * 1024));
  }

  grid(): Grid {
    this.#grid ??= csvGrid(this.text, this.#delim, this.sheets[0]!.name, { from: 1, to: Number.MAX_SAFE_INTEGER, keepChars: SHEET_KEEP_CHARS });
    return this.#grid;
  }
}

const books = new Map<string, Book>();

/** The book at `path` as it is now: kept while the file is unchanged (same size and modification time). */
async function bookFor(path: string, maxBytes: number, make: (bytes: Uint8Array) => Book): Promise<Book> {
  const st = await stat(path);
  const key = `${path}|${st.size}|${st.mtimeMs}`;
  let book = books.get(key);
  if (book) books.delete(key);
  else {
    if (st.size > maxBytes) throw new Error('too large');
    for (const k of books.keys()) if (k.startsWith(`${path}|`)) books.delete(k);
    book = make(new Uint8Array(await readFile(path)));
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
    return sheetPage(await bookFor(path, BOOK_MAX_BYTES, (bytes) => new SheetBook(bytes, SHEET_KEEP_CHARS)), name, path, size, sheet, from);
  } catch (err) {
    return { ...unreadable(err), name, path, size };
  }
}

/** A CSV file as a table (`decode`: its bytes as text, as a text file is read); `from`: its rows from that row on. */
export async function csvPreview(path: string, name: string, size: number, from: number, decode: (bytes: Uint8Array) => string): Promise<PreviewInfo> {
  try {
    const book = await bookFor(path, CSV_MAX_BYTES, (bytes) => new CsvBook(decode(bytes), name, /\.tsv$/i.test(name)));
    return sheetPage(book, name, path, size, 1, from);
  } catch (err) {
    return { ...unreadable(err), name, path, size };
  }
}

/** One page of a sheet: up to ROWS rows with content from row `from` on, and whether more follow. */
export function sheetPage(book: Book, name: string, path: string, size: number, sheet: number, from: number): PreviewInfo {
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
    // A CSV file's text, with its first page only.
    ...(book.text !== undefined && from <= 1 ? { text: book.text.slice(0, CSV_TEXT_CHARS) } : {}),
    // Rows never shown, however far it scrolls: the sheet was too big to keep whole.
    ...(g.clipped ? { left: { shown: g.rows.length, total: g.rowCount } } : {}),
  };
}
