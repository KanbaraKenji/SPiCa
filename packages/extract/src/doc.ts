// Word 97-2003 (.doc): the main text of the WordDocument stream (cfb), put together from the piece table, with
// tables told apart by the paragraphs' row-end mark (sprmPFTtp in the paragraph properties). Laid out as numbered
// blocks by the same code as .docx (docx.ts renderDocBlocks), so offset/limit page through it the same way.
// Not read: headings and list levels (they live in the style sheet), headers, footers, footnotes, comments.
import CFB from 'cfb';
import { renderDocBlocks, type DocBlock } from './docx.ts';
import type { SourceFile } from './source.ts';
import { ExtractError, type ExtractRequest, type ExtractResult } from './types.ts';
import { oneLine } from './util.ts';

const WHAT = 'Word 97-2003 document';

/** Paragraph-end marks with their place in the WordDocument stream (FC) and whether the paragraph ends a table row. */
interface Para {
  fcStart: number;
  fcEnd: number;
  /** Ends a table row (sprmPFTtp). */
  ttp: boolean;
  /** Inside a table (sprmPFInTable). */
  inTable: boolean;
}

interface Piece {
  cpStart: number;
  cpEnd: number;
  fc: number;
  compressed: boolean;
}

const CP1252 = new TextDecoder('windows-1252');

function fail(why: string): never {
  throw new ExtractError(`Not a readable ${WHAT} (${why}).`);
}

/** The FIB's (fc, lcb) pair number `i` of FibRgFcLcb97, and ccpText. */
function fib(word: Buffer): { tableName: string; ccpText: number; pair(i: number): [number, number] } {
  const ident = word.length >= 4 ? word.readUInt16LE(0) : 0;
  // Word 6.0 and 95 mark their file information block 0xA5DC, Word 97 and later 0xA5EC
  if (ident === 0xa5dc) throw new ExtractError('This is a Word 6.0/95 document, which is not read here; open it in Word and save it as .docx.');
  if (word.length < 0x200 || ident !== 0xa5ec) fail('no Word 97 file information block');
  const flags = word.readUInt16LE(0x0a);
  if (flags & 0x0100) throw new ExtractError('This document is password protected; it cannot be read without the password.');
  const nFib = word.readUInt16LE(2);
  if (nFib < 0x00c1) throw new ExtractError('This is a Word 6.0/95 document, which is not read here; open it in Word and save it as .docx.');
  let at = 32;
  const csw = word.readUInt16LE(at);
  at += 2 + csw * 2;
  const cslw = word.readUInt16LE(at);
  const lw = at + 2;
  at = lw + cslw * 4;
  const cbRgFcLcb = word.readUInt16LE(at);
  const fcLcb = at + 2;
  return {
    tableName: flags & 0x0200 ? '1Table' : '0Table',
    ccpText: word.readInt32LE(lw + 3 * 4),
    pair(i) {
      if (i >= cbRgFcLcb) return [0, 0];
      return [word.readUInt32LE(fcLcb + i * 8), word.readUInt32LE(fcLcb + i * 8 + 4)];
    },
  };
}

/** The piece table from the Clx. */
function pieces(table: Buffer, fc: number, lcb: number): Piece[] {
  let at = fc;
  const end = fc + lcb;
  while (at < end && table[at] === 0x01) at += 3 + table.readInt16LE(at + 1); // Prc: formatting, skipped
  if (table[at] !== 0x02) fail('no piece table');
  const size = table.readUInt32LE(at + 1);
  const plc = at + 5;
  const n = Math.floor((size - 4) / 12);
  const out: Piece[] = [];
  for (let i = 0; i < n; i++) {
    const raw = table.readUInt32LE(plc + (n + 1) * 4 + i * 8 + 2);
    const compressed = (raw & 0x40000000) !== 0;
    const pfc = raw & 0x3fffffff;
    out.push({ cpStart: table.readUInt32LE(plc + i * 4), cpEnd: table.readUInt32LE(plc + (i + 1) * 4), fc: compressed ? pfc / 2 : pfc, compressed });
  }
  return out;
}

/** Paragraph properties from the PAPX pages (PlcBtePapx): where each paragraph ends and whether it ends a table row. */
function paragraphs(word: Buffer, table: Buffer, fc: number, lcb: number): Para[] {
  const out: Para[] = [];
  if (lcb < 8) return out;
  const n = Math.floor((lcb - 4) / 8);
  for (let i = 0; i < n; i++) {
    const pn = table.readUInt32LE(fc + (n + 1) * 4 + i * 4) & 0x3fffff;
    const page = pn * 512;
    if (page + 512 > word.length) continue;
    const crun = word[page + 511]!;
    for (let k = 0; k < crun; k++) {
      const fcStart = word.readUInt32LE(page + k * 4);
      const fcEnd = word.readUInt32LE(page + (k + 1) * 4);
      const bOffset = word[page + (crun + 1) * 4 + k * 13]!;
      let ttp = false;
      let inTable = false;
      if (bOffset) {
        let at = page + bOffset * 2;
        let cb = word[at]!;
        at++;
        let len: number;
        if (cb === 0) {
          cb = word[at]!;
          at++;
          len = cb * 2;
        } else len = cb * 2 - 1;
        const stop = Math.min(page + 511, at + len);
        at += 2; // istd
        while (at + 2 <= stop) {
          const sprm = word.readUInt16LE(at);
          at += 2;
          const spra = sprm >> 13;
          if (sprm === 0x2417 || sprm === 0x244b) ttp ||= word[at] === 1; // sprmPFTtp, sprmPFInnerTtp
          if (sprm === 0x2416) inTable ||= word[at] === 1; // sprmPFInTable
          const size = [1, 1, 2, 4, 2, 2, -1, 3][spra]!;
          if (size >= 0) at += size;
          else if (sprm === 0xd608) at += word.readUInt16LE(at) + 1; // sprmTDefTable: a 2-byte length (MS-DOC 2.2.5.1)
          else if (sprm === 0xc615 && word[at] === 255) {
            // sprmPChgTabs with cb 255: tabs to delete (position + close range), then tabs to add (position + kind)
            let p = at + 1;
            p += 1 + word[p]! * 4;
            p += 1 + word[p]! * 3;
            at = p;
          } else at += word[at]! + 1;
        }
      }
      out.push({ fcStart, fcEnd, ttp, inTable });
    }
  }
  return out.sort((a, b) => a.fcStart - b.fcStart);
}

/** The paragraph a character at `fc` belongs to. */
function paraAt(paras: Para[], fc: number): Para | undefined {
  let lo = 0;
  let hi = paras.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = paras[mid]!;
    if (fc < p.fcStart) hi = mid - 1;
    else if (fc >= p.fcEnd) lo = mid + 1;
    else return p;
  }
  return undefined;
}

type Token = { t: 'text'; s: string } | { t: 'para'; inTable: boolean } | { t: 'cell' } | { t: 'row' };

/** The blocks of the main text, and how many pictures or embedded objects it holds (their content is not read). */
export function parseDoc(bytes: Uint8Array): { blocks: DocBlock[]; objects: number } {
  let doc: CFB.CFB$Container;
  try {
    doc = CFB.read(Buffer.from(bytes), { type: 'buffer' });
  } catch (err) {
    throw new ExtractError(`Not a readable ${WHAT}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // the root's streams: embedded objects (ObjectPool) carry streams of the same names
  const wordEntry = CFB.find(doc, '/WordDocument');
  if (!wordEntry?.content) fail('no WordDocument stream: it may be another Office file saved as .doc');
  const word = Buffer.from(wordEntry.content as Uint8Array);
  const f = fib(word);
  const tableEntry = CFB.find(doc, `/${f.tableName}`);
  if (!tableEntry?.content) fail(`the ${f.tableName} stream is missing`);
  const table = Buffer.from(tableEntry.content as Uint8Array);
  const [fcClx, lcbClx] = f.pair(33);
  const [fcPapx, lcbPapx] = f.pair(13);
  const list = pieces(table, fcClx, lcbClx);
  const paras = paragraphs(word, table, fcPapx, lcbPapx);

  // the main text (cp 0..ccpText); marks become tokens, field codes and objects are left out
  const tokens: Token[] = [];
  let text = '';
  const mark = (t: Token) => {
    if (text) tokens.push({ t: 'text', s: text });
    text = '';
    tokens.push(t);
  };
  const field: number[] = []; // nesting of fields: 1 while in the code part, 2 in the result
  let objects = 0;
  for (const pc of list) {
    if (pc.cpStart >= f.ccpText) break;
    const count = Math.min(pc.cpEnd, f.ccpText) - pc.cpStart;
    const width = pc.compressed ? 1 : 2;
    const raw = word.subarray(pc.fc, pc.fc + count * width);
    const chars = pc.compressed ? CP1252.decode(raw) : raw.toString('utf16le');
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      const code = ch.charCodeAt(0);
      if (code === 0x13) field.push(1);
      else if (code === 0x14) field[field.length - 1] = 2;
      else if (code === 0x15) field.pop();
      else if (field.includes(1)) continue;
      else if (code === 0x07) {
        const p = paraAt(paras, pc.fc + i * width);
        mark(p?.ttp ? { t: 'row' } : { t: 'cell' });
      } else if (code === 0x0d) mark({ t: 'para', inTable: paraAt(paras, pc.fc + i * width)?.inTable ?? false });
      else if (code === 0x0b || code === 0x0c) text += '\n';
      else if (code === 0x1e) text += '-';
      else if (code === 0x01 || code === 0x08) objects++;
      else if (code === 0x09 || code >= 0x20) text += ch;
      // 0x01 pictures, 0x02 footnote marks, 0x05 comment marks, 0x08 drawings, 0x1f optional hyphens: left out
    }
  }
  if (text) tokens.push({ t: 'text', s: text });

  const blocks: DocBlock[] = [];
  let rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  const clean = (s: string) => s.replace(/[ \t]+$/gm, '').trim();
  const endTable = () => {
    if (row.length) rows.push(row);
    if (rows.some((r) => r.some((c) => c))) blocks.push({ type: 'table', rows });
    rows = [];
    row = [];
  };
  // Without paragraph properties a row end cannot be told from an empty cell: then two cell marks in a row end it.
  const guessRows = paras.length === 0;
  let lastCell = false;
  for (const tk of tokens) {
    if (tk.t === 'text') {
      cur += tk.s;
      lastCell = false;
    } else if (tk.t === 'cell') {
      if (guessRows && lastCell && !cur) {
        rows.push(row);
        row = [];
        lastCell = false;
        continue;
      }
      row.push(oneLine(clean(cur)));
      cur = '';
      lastCell = true;
    } else if (tk.t === 'row') {
      rows.push(row);
      row = [];
      cur = '';
      lastCell = false;
    } else if (tk.inTable) {
      cur += '\n'; // a paragraph inside a cell: the cell goes on
    } else {
      if (row.length || rows.length) endTable();
      const t = clean(cur);
      if (t) blocks.push({ type: 'p', text: t });
      cur = '';
      lastCell = false;
    }
  }
  if (row.length || rows.length) endTable();
  const tail = clean(cur);
  if (tail) blocks.push({ type: 'p', text: tail });
  return { blocks, objects };
}

export async function extractDoc(src: SourceFile, req: ExtractRequest, maxChars: number): Promise<ExtractResult> {
  const { blocks, objects } = parseDoc(src.bytes);
  const note = objects > 0 ? `It holds ${objects} picture${objects === 1 ? '' : 's'} or embedded object${objects === 1 ? '' : 's'}, which are not read.` : undefined;
  return renderDocBlocks(blocks, WHAT, src, req, maxChars, note);
}
