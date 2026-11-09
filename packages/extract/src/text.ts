// Plain text, Markdown and CSV / TSV, with encoding detection (UTF-8, UTF-16 with BOM, GBK/GB18030).
import { extname } from 'node:path';
import { pickSheet, renderGrid, sheetInfo, shownRange, type Grid, cleanCell } from './grid.ts';
import type { SourceFile } from './source.ts';
import { ExtractError, type ExtractRequest, type ExtractResult } from './types.ts';
import { Budget } from './util.ts';

export interface Decoded {
  text: string;
  /** "utf-8", "utf-8-bom", "utf-16le", "utf-16be", "gbk" (decoded as GB18030, a superset). */
  encoding: string;
}

export function decodeText(bytes: Uint8Array): Decoded {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  const probe = bytes.subarray(0, 8192);
  if (probe.includes(0)) throw new ExtractError('This looks like a binary file, not text.');
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    // Not valid UTF-8: the usual alternative for Chinese files on Windows is GBK.
  }
  try {
    return { text: new TextDecoder('gb18030', { fatal: true }).decode(bytes), encoding: 'gbk' };
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8 (invalid bytes replaced)' };
  }
}

const MAX_LINE_CHARS = 2000;
const DEFAULT_LINES = 2000;

export async function extractText(src: SourceFile, req: ExtractRequest, maxChars: number): Promise<ExtractResult> {
  const base = src.metaBase('text');
  if (src.size === 0) return { text: 'The file is empty (0 bytes).', meta: base };
  const { text, encoding } = decodeText(src.bytes);
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const total = lines.length;
  const offset = Math.min(Math.max(1, req.offset ?? 1), total);
  const limit = Math.max(1, req.limit ?? DEFAULT_LINES);
  const budget = new Budget(maxChars - 300);
  let out = '';
  let end = offset - 1;
  for (let i = offset; i <= Math.min(total, offset - 1 + limit); i++) {
    let line = lines[i - 1]!;
    if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}…`;
    const next = `${String(i).padStart(6)}\t${line}\n`;
    if (!budget.take(next)) break;
    out += next;
    end = i;
  }
  const truncated = end < total;
  const head = `Text, ${total} line${total === 1 ? '' : 's'}, encoding ${encoding}.`;
  const more = truncated ? `\n[showing lines ${offset}-${end} of ${total}; use offset=${end + 1} to continue]` : '';
  return {
    text: `${head}\n${out.trimEnd()}${more}`,
    truncated,
    meta: { ...base, encoding, read: { rows: `${offset}-${end}` }, ...(truncated ? { truncated } : {}) },
  };
}

/** Pick the delimiter that splits the first lines most consistently. */
export function sniffDelimiter(sample: string): string {
  const lines = sample.split(/\r?\n/).filter(Boolean).slice(0, 20);
  let best = ',';
  let bestScore = 0;
  for (const d of [',', '\t', ';', '|']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    if (!counts.length || counts[0] === 0) continue;
    const same = counts.filter((c) => c === counts[0]).length;
    const score = same * 10 + counts[0]!;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** RFC 4180 records (quoted fields, doubled quotes, newlines inside quotes). */
export function* csvRecords(text: string, delim: string): Generator<string[]> {
  let field = '';
  let rec: string[] = [];
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) {
      rec.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      rec.push(field);
      yield rec;
      rec = [];
      field = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else field += ch;
    i++;
  }
  if (field !== '' || rec.length > 0) {
    rec.push(field);
    yield rec;
  }
}

export async function extractCsv(src: SourceFile, req: ExtractRequest, maxChars: number): Promise<ExtractResult> {
  const base = src.metaBase('csv');
  if (src.size === 0) return { text: 'The file is empty (0 bytes).', meta: base };
  const { text, encoding } = decodeText(src.bytes);
  const delim = extname(src.path).toLowerCase() === '.tsv' ? '\t' : sniffDelimiter(text.slice(0, 64 * 1024));
  const sheetName = src.name.replace(/\.[^.]+$/, '');
  if (req.sheet !== undefined && req.sheet !== '' && pickSheet([sheetName], req.sheet) === undefined) {
    throw new ExtractError(`A CSV file has a single table ("${sheetName}"); leave sheet empty.`);
  }
  const from = Math.max(1, req.offset ?? 1);
  const to = req.limit ? from + req.limit - 1 : Number.MAX_SAFE_INTEGER;
  const grid: Grid = { name: sheetName, rows: [], maxRow: 0, maxCol: 0, rowCount: 0 };
  let kept = 0;
  let n = 0;
  for (const rec of csvRecords(text, delim)) {
    n++;
    const cells = rec.map(cleanCell);
    if (!cells.some(Boolean)) continue;
    grid.rowCount++;
    grid.maxRow = n;
    let w = cells.length;
    while (w > 0 && !cells[w - 1]) w--;
    grid.maxCol = Math.max(grid.maxCol, w);
    if (n === 1 && from > 1) grid.header = [1, cells];
    if (n >= from && n <= to) {
      if (kept < maxChars) {
        grid.rows.push([n, cells]);
        kept += cells.reduce((a, c) => a + c.length + 1, 8);
      } else grid.clipped = true;
    }
  }
  const delimName = delim === '\t' ? 'tab' : delim === ',' ? 'comma' : `"${delim}"`;
  const info = sheetInfo(grid);
  const head = `CSV table, ${grid.rowCount} rows with data, ${info.range ?? 'empty'}, ${delimName}-separated, encoding ${encoding}.`;
  if (grid.rowCount === 0) return { text: `${head}\nThe table has no data.`, meta: { ...base, encoding, sheets: [info] } };
  const budget = new Budget(maxChars - head.length - 400);
  const r = renderGrid(grid, from, to, budget);
  const lines = [head, 'Row numbers are record numbers (1 = first line); columns are lettered.', '', r.text.trimEnd()];
  if (r.first === undefined) lines.push(`(no rows with data in ${from}-${to === Number.MAX_SAFE_INTEGER ? grid.maxRow : to})`);
  if (r.more) lines.push(`[Stopped because of the size limit. Continue with read_file offset=${(r.last ?? from - 1) + 1}.]`);
  const range = shownRange(grid, r);
  return {
    text: lines.join('\n').trimEnd(),
    truncated: r.more,
    meta: {
      ...base,
      encoding,
      sheets: [info],
      read: { ...(r.first !== undefined ? { rows: `${r.first}-${r.last}` } : {}), ...(range ? { range } : {}) },
      ...(r.more ? { truncated: true } : {}),
    },
  };
}
