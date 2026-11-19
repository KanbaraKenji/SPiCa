// @spica/extract: turn documents into model-readable text with structure and card metadata.
// Plug into the kernel with `new Runtime({ extractors: createExtractors() })`.
import { extname } from 'node:path';
import { extractDoc } from './doc.ts';
import { extractDocx } from './docx.ts';
import { extractPdf } from './pdf.ts';
import { extractPpt } from './ppt.ts';
import { extractPptx } from './pptx.ts';
import { loadSource, type SourceFile } from './source.ts';
import { extractCsv, extractText } from './text.ts';
import type { ExtractRequest, ExtractResult, FileKind } from './types.ts';
import { extractXls } from './xls.ts';
import { extractXlsx } from './xlsx.ts';

import { ExtractError } from './types.ts';
export { ExtractError, type ExtractRequest, type ExtractResult, type FileCardMeta, type FileKind, type PageImage, type ReadLocation, type SheetInfo } from './types.ts';
export { csvGrid, decodeText, sniffDelimiter } from './text.ts';
export { SheetBook } from './xlsx.ts';
export type { Grid } from './grid.ts';
export { colName } from './util.ts';
export { setPdfiumWasm } from './pdf-render.ts';

export interface ExtractOptions {
  /** Cap on characters returned by one read (the kernel's own cap applies too). Default 60 000. */
  maxChars?: number;
  /** Files larger than this are refused. Default 200 MB. */
  maxFileBytes?: number;
}

type Handler = (src: SourceFile, req: ExtractRequest, maxChars: number, signal?: AbortSignal) => Promise<ExtractResult>;

/** What the bytes are, whatever the extension says: an OLE file (Office 97-2003), a ZIP (Office 2007+), or text. */
function sniff(bytes: Uint8Array): 'ole' | 'zip' | 'rtf' | 'text' | 'other' {
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'ole';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip';
  const head = new TextDecoder().decode(bytes.subarray(0, 512));
  if (head.startsWith('{\\rtf')) return 'rtf';
  return bytes.subarray(0, 8192).includes(0) ? 'other' : 'text';
}

/** .xls: Excel 97-2003, else an .xlsx or a text table (HTML or CSV/TSV) under the old name. */
const extractOldExcel: Handler = (src, req, maxChars, signal) => {
  const kind = sniff(src.bytes);
  if (kind === 'ole') return extractXls(src, req, maxChars, signal);
  if (kind === 'zip') return extractXlsx(src, req, maxChars, signal);
  if (kind === 'text') {
    const head = new TextDecoder().decode(src.bytes.subarray(0, 512)).trimStart().toLowerCase();
    return head.startsWith('<') ? extractText(src, req, maxChars) : extractCsv(src, req, maxChars);
  }
  throw new ExtractError('Not a readable Excel 97-2003 workbook (neither an Office file nor a text table).');
};

/** .doc: Word 97-2003, else a .docx or text (HTML) under the old name. */
const extractOldWord: Handler = (src, req, maxChars) => {
  const kind = sniff(src.bytes);
  if (kind === 'ole') return extractDoc(src, req, maxChars);
  if (kind === 'zip') return extractDocx(src, req, maxChars);
  if (kind === 'text') return extractText(src, req, maxChars);
  if (kind === 'rtf') throw new ExtractError('This .doc file is an RTF document, which is not read here; open it in Word and save it as .docx.');
  throw new ExtractError('Not a readable Word 97-2003 document (not an Office file).');
};

/** .ppt: PowerPoint 97-2003, else a .pptx under the old name. */
const extractOldPowerPoint: Handler = (src, req, maxChars, signal) => {
  const kind = sniff(src.bytes);
  if (kind === 'ole') return extractPpt(src, req, maxChars, signal);
  if (kind === 'zip') return extractPptx(src, req, maxChars, signal);
  throw new ExtractError('Not a readable PowerPoint 97-2003 presentation (not an Office file).');
};

interface Format {
  kind: FileKind;
  label: string;
  extensions: string[];
  run: Handler;
}

export const FORMATS: readonly Format[] = [
  { kind: 'pdf', label: 'PDF', extensions: ['.pdf'], run: extractPdf },
  { kind: 'docx', label: 'Word', extensions: ['.docx', '.docm'], run: extractDocx },
  { kind: 'docx', label: 'Word', extensions: ['.doc'], run: extractOldWord },
  { kind: 'xlsx', label: 'Excel', extensions: ['.xlsx', '.xlsm'], run: extractXlsx },
  { kind: 'xlsx', label: 'Excel', extensions: ['.xls'], run: extractOldExcel },
  { kind: 'pptx', label: 'PowerPoint', extensions: ['.pptx', '.pptm'], run: extractPptx },
  { kind: 'pptx', label: 'PowerPoint', extensions: ['.ppt'], run: extractOldPowerPoint },
  { kind: 'csv', label: 'CSV', extensions: ['.csv', '.tsv'], run: extractCsv },
  { kind: 'text', label: 'Text', extensions: ['.txt', '.md', '.markdown', '.log'], run: extractText },
];

export const DEFAULT_MAX_CHARS = 60_000;
const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024;

export function formatFor(path: string): Format | undefined {
  const ext = extname(path).toLowerCase();
  return FORMATS.find((f) => f.extensions.includes(ext));
}

/** Extract one file. Throws ExtractError with a model-facing message for unreadable files. */
export async function extractFile(path: string, req: ExtractRequest = {}, signal?: AbortSignal, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const fmt = formatFor(path);
  if (!fmt) throw new Error(`No extractor for "${extname(path) || 'no extension'}".`);
  const src = await loadSource(path, opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const maxChars = Math.min(req.maxChars ?? Number.POSITIVE_INFINITY, opts.maxChars ?? DEFAULT_MAX_CHARS);
  if (src.size === 0) {
    return { text: `${fmt.label} file is empty (0 bytes).`, meta: { ...src.metaBase(fmt.kind), read: {} } };
  }
  return fmt.run(src, req, maxChars, signal);
}

/** Same shape as the kernel's FileExtractor (`@spica/core`). */
export interface Extractor {
  extensions: string[];
  extract(path: string, req: ExtractRequest & { maxChars: number }, signal: AbortSignal): Promise<ExtractResult>;
}

/** One extractor per format, ready for `new Runtime({ extractors })`. */
export function createExtractors(opts: ExtractOptions = {}): Extractor[] {
  return FORMATS.map((f) => ({
    extensions: [...f.extensions],
    extract: (path, req, signal) => extractFile(path, req, signal, opts),
  }));
}
