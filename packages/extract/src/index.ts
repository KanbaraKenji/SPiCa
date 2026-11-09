// @spica/extract: turn documents into model-readable text with structure and card metadata.
// Plug into the kernel with `new Runtime({ extractors: createExtractors() })`.
import { extname } from 'node:path';
import { extractDocx } from './docx.ts';
import { extractPdf } from './pdf.ts';
import { extractPptx } from './pptx.ts';
import { loadSource, type SourceFile } from './source.ts';
import { extractCsv, extractText } from './text.ts';
import type { ExtractRequest, ExtractResult, FileKind } from './types.ts';
import { extractXlsx } from './xlsx.ts';

export { ExtractError, type ExtractRequest, type ExtractResult, type FileCardMeta, type FileKind, type ReadLocation, type SheetInfo } from './types.ts';
export { decodeText } from './text.ts';

export interface ExtractOptions {
  /** Cap on characters returned by one read (the kernel's own cap applies too). Default 60 000. */
  maxChars?: number;
  /** Files larger than this are refused. Default 200 MB. */
  maxFileBytes?: number;
}

type Handler = (src: SourceFile, req: ExtractRequest, maxChars: number, signal?: AbortSignal) => Promise<ExtractResult>;

interface Format {
  kind: FileKind;
  label: string;
  extensions: string[];
  run: Handler;
}

export const FORMATS: readonly Format[] = [
  { kind: 'pdf', label: 'PDF', extensions: ['.pdf'], run: extractPdf },
  { kind: 'docx', label: 'Word', extensions: ['.docx', '.docm'], run: extractDocx },
  { kind: 'xlsx', label: 'Excel', extensions: ['.xlsx', '.xlsm'], run: extractXlsx },
  { kind: 'pptx', label: 'PowerPoint', extensions: ['.pptx', '.pptm'], run: extractPptx },
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
