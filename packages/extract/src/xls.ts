// Excel 97-2003 (.xls, BIFF8): the Workbook stream of the OLE file (cfb), read record by record: sheets, shared
// strings, number formats (dates), and the cells' values (formulas as their last calculated result). Laid out by
// the same code as .xlsx (xlsx.ts extractSheets), so sheets, rows and ranges are chosen the same way.
import CFB from 'cfb';
import { cleanCell, type Grid } from './grid.ts';
import type { SourceFile } from './source.ts';
import { ExtractError, type ExtractRequest, type ExtractResult } from './types.ts';
import { BUILTIN_KINDS, extractSheets, formatKind, numberText, type NumKind, type SheetSource, type SheetWindow } from './xlsx.ts';

const WHAT = 'Excel 97-2003 workbook';

const R = {
  BOF: 0x0809,
  EOF: 0x000a,
  FILEPASS: 0x002f,
  DATEMODE: 0x0022,
  FORMAT: 0x041e,
  XF: 0x00e0,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  FORMULA: 0x0006,
  STRING: 0x0207,
  BOOLERR: 0x0205,
} as const;

const ERRORS: Record<number, string> = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A' };

interface Rec {
  type: number;
  data: Buffer;
  /** Data of the CONTINUE records right after it. */
  more: Buffer[];
}

/** Records from `start` up to the next EOF (a substream), CONTINUE records attached to the one before. */
function records(stream: Buffer, start: number): Rec[] {
  const out: Rec[] = [];
  let pos = start;
  while (pos + 4 <= stream.length) {
    const type = stream.readUInt16LE(pos);
    const len = stream.readUInt16LE(pos + 2);
    const data = stream.subarray(pos + 4, Math.min(stream.length, pos + 4 + len));
    pos += 4 + len;
    if (type === R.CONTINUE && out.length > 0) out.at(-1)!.more.push(data);
    else out.push({ type, data, more: [] });
    if (type === R.EOF) break;
  }
  return out;
}

/** Reads across a record and its CONTINUE records; a string's characters restart with a flags byte in each CONTINUE. */
class Reader {
  #segs: Buffer[];
  #i = 0;
  #pos = 0;
  constructor(rec: Rec, at = 0) {
    this.#segs = [rec.data, ...rec.more];
    this.#pos = at;
  }
  #ensure(): Buffer {
    while (this.#i < this.#segs.length && this.#pos >= this.#segs[this.#i]!.length) {
      this.#i++;
      this.#pos = 0;
    }
    const seg = this.#segs[this.#i];
    if (!seg) throw new ExtractError(`Not a readable ${WHAT} (a record ends early; the file may be damaged).`);
    return seg;
  }
  bytes(n: number): Buffer {
    const parts: Buffer[] = [];
    while (n > 0) {
      const seg = this.#ensure();
      const take = Math.min(n, seg.length - this.#pos);
      parts.push(seg.subarray(this.#pos, this.#pos + take));
      this.#pos += take;
      n -= take;
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }
  u8(): number {
    return this.bytes(1)[0]!;
  }
  u16(): number {
    return this.bytes(2).readUInt16LE(0);
  }
  u32(): number {
    return this.bytes(4).readUInt32LE(0);
  }
  /** `cch` characters, 1 or 2 bytes each by the flags byte, which a CONTINUE record repeats. */
  chars(cch: number, high: boolean): string {
    let out = '';
    let at = this.#i;
    while (cch > 0) {
      const seg = this.#ensure();
      if (this.#i !== at) {
        // a string's characters going on in the next record start with a new flags byte
        high = (seg[this.#pos]! & 1) === 1;
        this.#pos++;
        at = this.#i;
        continue;
      }
      const width = high ? 2 : 1;
      const n = Math.min(cch, Math.floor((seg.length - this.#pos) / width));
      if (n === 0) throw new ExtractError(`Not a readable ${WHAT} (a string is cut; the file may be damaged).`);
      const b = seg.subarray(this.#pos, this.#pos + n * width);
      out += high ? b.toString('utf16le') : b.toString('latin1');
      this.#pos += n * width;
      cch -= n;
      if (cch > 0) this.#pos = seg.length; // on to the next record
    }
    return out;
  }
  /** XLUnicodeRichExtendedString (SST) or, without rich/extended parts, XLUnicodeString. */
  string(cch = this.u16()): string {
    const flags = this.u8();
    const runs = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    const text = this.chars(cch, (flags & 1) === 1);
    if (runs) this.bytes(runs * 4);
    if (ext) this.bytes(ext);
    return text;
  }
}

/** An RK value: a 30-bit integer or the high 30 bits of a double, optionally divided by 100. */
export function rkValue(rk: number): number {
  let v: number;
  if (rk & 0x02) v = rk >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    v = b.readDoubleLE(0);
  }
  return rk & 0x01 ? v / 100 : v;
}

interface XlsBook {
  stream: Buffer;
  sheets: { name: string; hidden: boolean; at: number }[];
  date1904: boolean;
  shared: string[];
  styleKinds: (NumKind | undefined)[];
}

function openXls(bytes: Uint8Array): XlsBook {
  let doc: CFB.CFB$Container;
  try {
    doc = CFB.read(Buffer.from(bytes), { type: 'buffer' });
  } catch (err) {
    throw new ExtractError(`Not a readable ${WHAT}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entry = CFB.find(doc, 'Workbook') ?? CFB.find(doc, 'Book');
  if (!entry?.content) throw new ExtractError(`Not a readable ${WHAT} (no Workbook stream: it may be another Office file saved as .xls).`);
  const stream = Buffer.from(entry.content as Uint8Array);
  const recs = records(stream, 0);
  const bof = recs[0];
  if (bof?.type !== R.BOF) throw new ExtractError(`Not a readable ${WHAT} (the Workbook stream does not start with a BOF record).`);
  if (bof.data.readUInt16LE(0) !== 0x0600) {
    throw new ExtractError('This is an Excel 5.0/95 workbook (BIFF5), which is not read here; open it in Excel and save it as .xlsx.');
  }
  const book: XlsBook = { stream, sheets: [], date1904: false, shared: [], styleKinds: [] };
  const custom = new Map<number, NumKind | undefined>();
  const xfFormats: number[] = [];
  for (const r of recs) {
    switch (r.type) {
      case R.FILEPASS:
        throw new ExtractError('This workbook is password protected; it cannot be read without the password.');
      case R.DATEMODE:
        book.date1904 = r.data.readUInt16LE(0) === 1;
        break;
      case R.FORMAT: {
        const rd = new Reader(r);
        const id = rd.u16();
        custom.set(id, formatKind(rd.string()));
        break;
      }
      case R.XF:
        xfFormats.push(r.data.readUInt16LE(2));
        break;
      case R.BOUNDSHEET: {
        const at = r.data.readUInt32LE(0);
        const state = r.data[4]! & 0x03;
        const dt = r.data[5]!;
        const rd = new Reader(r, 6);
        const name = rd.string(rd.u8());
        if (dt === 0) book.sheets.push({ name, hidden: state !== 0, at }); // worksheets (not charts, macro sheets)
        break;
      }
      case R.SST: {
        const rd = new Reader(r, 8);
        const unique = r.data.readUInt32LE(4);
        for (let k = 0; k < unique; k++) book.shared.push(rd.string());
        break;
      }
    }
  }
  book.styleKinds = xfFormats.map((id) => (custom.has(id) ? custom.get(id) : BUILTIN_KINDS[id]));
  return book;
}

function sheetGrid(book: XlsBook, index: number, win: SheetWindow): Grid {
  const sheet = book.sheets[index]!;
  const recs = records(book.stream, sheet.at);
  if (recs[0]?.type !== R.BOF) throw new ExtractError(`Sheet "${sheet.name}" is missing from the workbook (damaged file).`);
  const rows = new Map<number, string[]>();
  let maxCol = 0;
  const put = (row: number, col: number, text: string) => {
    const t = cleanCell(text);
    if (!t) return;
    let cells = rows.get(row + 1);
    if (!cells) rows.set(row + 1, (cells = []));
    cells[col] = t;
    maxCol = Math.max(maxCol, col + 1);
  };
  const num = (v: number, xf: number) => numberText(String(v), book.styleKinds[xf], book.date1904);
  for (let k = 1; k < recs.length; k++) {
    const r = recs[k]!;
    const d = r.data;
    if (d.length < 6 && r.type !== R.EOF) continue;
    switch (r.type) {
      case R.LABELSST:
        put(d.readUInt16LE(0), d.readUInt16LE(2), book.shared[d.readUInt32LE(6)] ?? '');
        break;
      case R.LABEL:
        put(d.readUInt16LE(0), d.readUInt16LE(2), new Reader(r, 6).string());
        break;
      case R.NUMBER:
        put(d.readUInt16LE(0), d.readUInt16LE(2), num(d.readDoubleLE(6), d.readUInt16LE(4)));
        break;
      case R.RK:
        put(d.readUInt16LE(0), d.readUInt16LE(2), num(rkValue(d.readUInt32LE(6)), d.readUInt16LE(4)));
        break;
      case R.MULRK: {
        const row = d.readUInt16LE(0);
        const first = d.readUInt16LE(2);
        const n = Math.floor((d.length - 6) / 6);
        for (let c = 0; c < n; c++) put(row, first + c, num(rkValue(d.readUInt32LE(4 + c * 6 + 2)), d.readUInt16LE(4 + c * 6)));
        break;
      }
      case R.BOOLERR: {
        const v = d[6]!;
        put(d.readUInt16LE(0), d.readUInt16LE(2), d[7] ? (ERRORS[v] ?? '#ERROR') : v ? 'TRUE' : 'FALSE');
        break;
      }
      case R.FORMULA: {
        const row = d.readUInt16LE(0);
        const col = d.readUInt16LE(2);
        if (d.readUInt16LE(12) !== 0xffff) {
          put(row, col, num(d.readDoubleLE(6), d.readUInt16LE(4)));
          break;
        }
        const kind = d[6]!;
        if (kind === 0) {
          const next = recs[k + 1];
          if (next?.type === R.STRING) {
            put(row, col, new Reader(next).string());
            k++;
          }
        } else if (kind === 1) put(row, col, d[8] ? 'TRUE' : 'FALSE');
        else if (kind === 2) put(row, col, ERRORS[d[8]!] ?? '#ERROR');
        break;
      }
    }
  }
  const grid: Grid = { name: sheet.name, rows: [], maxRow: 0, maxCol, rowCount: rows.size };
  let kept = 0;
  for (const n of [...rows.keys()].sort((a, b) => a - b)) {
    const line = Array.from({ length: maxCol }, (_, i) => rows.get(n)![i] ?? '');
    grid.maxRow = n;
    if (n === 1 && win.from > 1) grid.header = [1, line];
    if (n < win.from || n > win.to) continue;
    if (kept < win.keepChars) {
      grid.rows.push([n, line]);
      kept += line.reduce((a, c) => a + c.length + 1, 8);
    } else grid.clipped = true;
  }
  return grid;
}

/** The workbook as extractSheets reads it. */
export function xlsSource(bytes: Uint8Array): SheetSource {
  const book = openXls(bytes);
  if (book.sheets.length === 0) throw new ExtractError(`Not a readable ${WHAT} (it lists no worksheets).`);
  const grids = new Map<number, Grid>();
  return {
    label: WHAT,
    sheets: book.sheets,
    // the whole sheet is one pass over its records; keep it for the table of contents
    grid: (i, win) => {
      const g = sheetGrid(book, i, win);
      if (win.to === 0) grids.set(i, g);
      return g;
    },
    size: (i) => grids.get(i),
  };
}

export async function extractXls(src: SourceFile, req: ExtractRequest, maxChars: number, signal?: AbortSignal): Promise<ExtractResult> {
  return extractSheets(xlsSource(src.bytes), src, req, maxChars, signal);
}
