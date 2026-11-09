// Shapes shared by all extractors. FileCardMeta extends the protocol's card type
// (what the desktop file card shows) with a few extra fields; it stays assignable to it.
import type { FileCardMeta as ProtocolFileCardMeta } from '@spica/protocol';

export type FileKind = ProtocolFileCardMeta['kind'];

/** What the model asked for (same shape as the kernel's ExtractRequest). */
export interface ExtractRequest {
  /** Pages (PDF) or slides (PPTX): "3", "2-5", "1,4,7-9". */
  pages?: string;
  /** Sheet name or 1-based index (XLSX). CSV has a single sheet. */
  sheet?: string;
  /** First row (sheets), block (DOCX) or line (text), 1-based. */
  offset?: number;
  /** How many rows / blocks / lines to return. */
  limit?: number;
  /** Upper bound on returned characters; the extractor also applies its own cap. */
  maxChars?: number;
}

export interface SheetInfo {
  name: string;
  rows: number;
  cols: number;
  /** Used range like "A1:F120"; empty sheets have none. */
  range?: string;
}

/** Where the returned text came from, for the card and for citations. */
export interface ReadLocation {
  pages?: string;
  sheet?: string;
  rows?: string;
  range?: string;
  /** DOCX block numbers, e.g. "1-40". */
  blocks?: string;
}

export interface FileCardMeta extends Omit<ProtocolFileCardMeta, 'sheets' | 'read'> {
  sheets?: SheetInfo[];
  /** DOCX: paragraphs + tables. */
  blockCount?: number;
  read: ReadLocation;
}

export interface ExtractResult {
  /** Laid out for the model; the kernel prepends the fetch-time line and a file header. */
  text: string;
  meta: FileCardMeta;
  truncated?: boolean;
}

/** Thrown for files that cannot be read (corrupt, encrypted, too large). The message is model-facing. */
export class ExtractError extends Error {
  override name = 'ExtractError';
}
