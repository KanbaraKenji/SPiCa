// Older Office files for tests, assembled by hand to the published layouts (MS-XLS BIFF8, MS-DOC Word 97) inside an
// OLE file written by cfb, and a scanned PDF (a text page drawn by PDFium, put back as a picture without a text
// layer). All content is fictional and generic.
import { deflateSync } from 'node:zlib';
import CFB from 'cfb';
import { PDFDocument } from 'pdf-lib';
import { openDrawer } from '../pdf-render.ts';
import { makePdf } from './fixtures.ts';

function ole(streams: Record<string, Buffer>): Uint8Array {
  const doc = CFB.utils.cfb_new();
  for (const [name, data] of Object.entries(streams)) CFB.utils.cfb_add(doc, name, data);
  return new Uint8Array(CFB.write(doc, { type: 'buffer', fileType: 'cfb' }) as Buffer);
}

// ---------------------------------------------------------------- XLS (BIFF8)

function rec(type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(data.length, 2);
  return Buffer.concat([head, data]);
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const f64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(n);
  return b;
};
/** Characters as 1 byte (Latin-1) when they fit, else UTF-16: flags byte + characters. */
function chars(s: string): Buffer {
  const wide = [...s].some((c) => c.charCodeAt(0) > 0xff);
  return Buffer.concat([Buffer.from([wide ? 1 : 0]), Buffer.from(s, wide ? 'utf16le' : 'latin1')]);
}
/** XLUnicodeString: cch (2 bytes), flags, characters. */
const xstr = (s: string) => Buffer.concat([u16(s.length), chars(s)]);
const cell = (row: number, col: number, xf: number) => Buffer.concat([u16(row), u16(col), u16(xf)]);
/** An RK integer. */
const rkInt = (n: number) => u32(((n << 2) | 0x02) >>> 0);

export interface XlsSheet {
  name: string;
  hidden?: boolean;
  /** Built from the cell helpers below (row and column 0-based). */
  cells: Buffer[];
}

/** Cell records for XlsSheet.cells. `xf` 0 is General, 1 the date format (yyyy-mm-dd), 2 percent. */
export const xlsCell = {
  sst: (row: number, col: number, index: number) => rec(0x00fd, Buffer.concat([cell(row, col, 0), u32(index)])),
  label: (row: number, col: number, text: string) => rec(0x0204, Buffer.concat([cell(row, col, 0), xstr(text)])),
  number: (row: number, col: number, v: number, xf = 0) => rec(0x0203, Buffer.concat([cell(row, col, xf), f64(v)])),
  rk: (row: number, col: number, n: number, xf = 0) => rec(0x027e, Buffer.concat([cell(row, col, xf), rkInt(n)])),
  mulrk: (row: number, col: number, ns: number[]) =>
    rec(0x00bd, Buffer.concat([u16(row), u16(col), ...ns.map((n) => Buffer.concat([u16(0), rkInt(n)])), u16(col + ns.length - 1)])),
  bool: (row: number, col: number, v: boolean) => rec(0x0205, Buffer.concat([cell(row, col, 0), Buffer.from([v ? 1 : 0, 0])])),
  error: (row: number, col: number, code: number) => rec(0x0205, Buffer.concat([cell(row, col, 0), Buffer.from([code, 1])])),
  formula: (row: number, col: number, v: number) => rec(0x0006, Buffer.concat([cell(row, col, 0), f64(v), u16(0), u32(0), u16(0)])),
  formulaText: (row: number, col: number, text: string) =>
    Buffer.concat([
      rec(0x0006, Buffer.concat([cell(row, col, 0), Buffer.from([0, 0, 0, 0, 0, 0, 0xff, 0xff]), u16(0), u32(0), u16(0)])),
      rec(0x0207, xstr(text)),
    ]),
};

/**
 * A BIFF8 workbook. The shared strings are split over SST and CONTINUE records after `sstSplit` bytes of character
 * data of the string at `sstSplitAt`, so a string goes on in the next record (with its new flags byte).
 */
export function makeXls(sheets: XlsSheet[], shared: string[], opts: { date1904?: boolean; sstSplitAt?: number } = {}): Uint8Array {
  // SST: header, then strings; one string may be cut in the middle into a CONTINUE record
  const sstParts: Buffer[] = [u32(shared.length), u32(shared.length)];
  let cont: Buffer | undefined;
  shared.forEach((s, i) => {
    if (i === opts.sstSplitAt && s.length > 2) {
      const cut = Math.floor(s.length / 2);
      const wide = [...s].some((c) => c.charCodeAt(0) > 0xff);
      sstParts.push(u16(s.length), Buffer.from([wide ? 1 : 0]), Buffer.from(s.slice(0, cut), wide ? 'utf16le' : 'latin1'));
      cont = chars(s.slice(cut));
      return;
    }
    if (cont) cont = Buffer.concat([cont, xstr(s)]);
    else sstParts.push(xstr(s));
  });
  const xf = (fmt: number) => Buffer.concat([u16(0), u16(fmt), Buffer.alloc(16)]);
  const globalsHead = Buffer.concat([
    rec(0x0809, Buffer.concat([u16(0x0600), u16(0x0005), Buffer.alloc(12)])),
    rec(0x0022, u16(opts.date1904 ? 1 : 0)),
    rec(0x041e, Buffer.concat([u16(164), xstr('yyyy-mm-dd')])),
    rec(0x00e0, xf(0)),
    rec(0x00e0, xf(164)),
    rec(0x00e0, xf(9)),
  ]);
  const sheetRec = (s: XlsSheet, at: number) => rec(0x0085, Buffer.concat([u32(at), Buffer.from([s.hidden ? 1 : 0, 0, s.name.length]), chars(s.name)]));
  const tail = Buffer.concat([rec(0x00fc, Buffer.concat(sstParts)), ...(cont ? [rec(0x003c, cont)] : []), rec(0x000a, Buffer.alloc(0))]);
  const bodies = sheets.map((s) => Buffer.concat([rec(0x0809, Buffer.concat([u16(0x0600), u16(0x0010), Buffer.alloc(12)])), ...s.cells, rec(0x000a, Buffer.alloc(0))]));
  // BOUNDSHEET records hold where each sheet starts: lay out once to measure, then write
  const sheetRecsLen = sheets.reduce((a, s) => a + sheetRec(s, 0).length, 0);
  let at = globalsHead.length + sheetRecsLen + tail.length;
  const recs = sheets.map((s, i) => {
    const r = sheetRec(s, at);
    at += bodies[i]!.length;
    return r;
  });
  return ole({ Workbook: Buffer.concat([globalsHead, ...recs, tail, ...bodies]) });
}

// ---------------------------------------------------------------- DOC (Word 97)

export type DocPara = string | { cells: string[][] };

/**
 * A Word 97 document: paragraphs and tables (each row's cells end with a cell mark, then a row-end paragraph). The
 * text is one UTF-16 piece; each paragraph's properties (in table, row end) are written in PAPX pages.
 * A paragraph text may hold "{code|result}", written as a field (the code is left out when read).
 */
export function makeDoc(paras: DocPara[]): Uint8Array {
  // text and paragraph runs: [start char, end char (after the mark), inTable, ttp]
  let text = '';
  const runs: [number, number, boolean, boolean][] = [];
  const put = (s: string, mark: string, inTable: boolean, ttp: boolean) => {
    const start = text.length;
    text += s.replace(/\{([^|}]*)\|([^}]*)\}/g, '\u0013$1\u0014$2\u0015') + mark;
    runs.push([start, text.length, inTable, ttp]);
  };
  for (const p of paras) {
    if (typeof p === 'string') put(p, '\r', false, false);
    else {
      for (const row of p.cells) {
        for (const c of row) {
          const lines = c.split('\n');
          lines.slice(0, -1).forEach((l) => put(l, '\r', true, false));
          put(lines.at(-1)!, '\u0007', true, false);
        }
        put('', '\u0007', true, true);
      }
    }
  }
  const TEXT_FC = 0x400;
  const ccpText = text.length;
  const textBytes = Buffer.from(text, 'utf16le');
  // one FKP page (512 bytes) after the text
  const fkpPage = Math.ceil((TEXT_FC + textBytes.length) / 512);
  const fkp = Buffer.alloc(512);
  const crun = runs.length;
  runs.forEach(([s, e], k) => {
    fkp.writeUInt32LE(TEXT_FC + s * 2, k * 4);
    if (k === crun - 1) fkp.writeUInt32LE(TEXT_FC + e * 2, (k + 1) * 4);
  });
  // PapxInFkp from the end of the page backwards: cb, istd, sprms
  let free = 510;
  runs.forEach(([, , inTable, ttp], k) => {
    // variable-length sprms before the flags, as Word writes them: cell paragraphs change tabs (sprmPChgTabs in its
    // cb 255 form: one tab deleted, one added), row ends define the table (sprmTDefTable, a 2-byte length)
    const tabs = Buffer.from([255, 1, 0x40, 0x01, 0x10, 0x00, 1, 0x80, 0x02, 0x00]);
    const defTable = Buffer.concat([u16(7), Buffer.from([2, 0, 0, 0x10, 0x05, 0x20])]);
    const grpprl = Buffer.concat([
      u16(0),
      ...(inTable && !ttp ? [u16(0xc615), tabs] : []),
      ...(ttp ? [u16(0xd608), defTable] : []),
      ...(inTable ? [u16(0x2416), Buffer.from([1])] : []),
      ...(ttp ? [u16(0x2417), Buffer.from([1])] : []),
    ]);
    // cb != 0: grpprl length is 2*cb - 1 (pad to that)
    const cb = Math.ceil((grpprl.length + 1) / 2);
    const body = Buffer.concat([Buffer.from([cb]), grpprl, Buffer.alloc(2 * cb - 1 - grpprl.length)]);
    free -= body.length;
    free -= free % 2;
    body.copy(fkp, free);
    fkp[(crun + 1) * 4 + k * 13] = free / 2;
  });
  if (free < (crun + 1) * 4 + crun * 13) throw new Error('makeDoc: too many paragraphs for one PAPX page');
  fkp[511] = crun;

  // FIB: base 32 bytes, csw 14, cslw 22, cbRgFcLcb 93 pairs
  const fib = Buffer.alloc(TEXT_FC);
  fib.writeUInt16LE(0xa5ec, 0);
  fib.writeUInt16LE(0x00c1, 2);
  fib.writeUInt16LE(0x0200, 0x0a); // fWhichTblStm: 1Table
  let at = 32;
  fib.writeUInt16LE(14, at);
  at += 2 + 28;
  fib.writeUInt16LE(22, at);
  const lw = at + 2;
  fib.writeInt32LE(ccpText, lw + 3 * 4);
  at = lw + 22 * 4;
  fib.writeUInt16LE(93, at);
  const pairs = at + 2;

  // table stream: Clx (one piece, UTF-16) then PlcBtePapx (one page)
  const plcPcd = Buffer.concat([u32(0), u32(ccpText), u16(0), u32(TEXT_FC), u16(0)]);
  const clx = Buffer.concat([Buffer.from([0x02]), u32(plcPcd.length), plcPcd]);
  const bte = Buffer.concat([u32(TEXT_FC), u32(TEXT_FC + textBytes.length), u32(fkpPage)]);
  const table = Buffer.concat([clx, bte]);
  fib.writeUInt32LE(0, pairs + 33 * 8);
  fib.writeUInt32LE(clx.length, pairs + 33 * 8 + 4);
  fib.writeUInt32LE(clx.length, pairs + 13 * 8);
  fib.writeUInt32LE(bte.length, pairs + 13 * 8 + 4);

  const word = Buffer.alloc((fkpPage + 1) * 512);
  fib.copy(word, 0);
  textBytes.copy(word, TEXT_FC);
  fkp.copy(word, fkpPage * 512);
  return ole({ WordDocument: word, '1Table': table });
}

// ---------------------------------------------------------------- scanned PDF

function greyPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = rgba[(y * width + x) * 4]!;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/** A PDF whose pages are pictures of `pages` (text drawn by PDFium), with no text layer: what a scanner makes. */
export async function makeScannedTextPdf(pages: string[][], textPages: string[][] = []): Promise<Uint8Array> {
  const drawer = await openDrawer(await makePdf(pages));
  const out = await PDFDocument.create();
  try {
    for (let i = 0; i < pages.length; i++) {
      const p = drawer.draw(i + 1, 1200);
      const img = await out.embedPng(greyPng(p.width, p.height, p.rgba));
      out.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
    }
  } finally {
    drawer.close();
  }
  if (textPages.length > 0) {
    const text = await PDFDocument.load(await makePdf(textPages));
    for (const pg of await out.copyPages(text, text.getPageIndices())) out.addPage(pg);
  }
  return out.save();
}
