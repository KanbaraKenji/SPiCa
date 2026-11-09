// Excel (.xlsx / .xlsm): sheets, shared strings, number formats (dates) from the OOXML package.
import { cleanCell, pickSheet, renderGrid, sheetInfo, shownRange, type Grid } from './grid.ts';
import { openPackage, partText, relationships, walkXml, type ZipParts } from './ooxml.ts';
import type { SourceFile } from './source.ts';
import { ExtractError, type ExtractRequest, type ExtractResult } from './types.ts';
import { Budget, parseCellRef, throwIfAborted } from './util.ts';

const WHAT = 'Excel workbook';

interface Workbook {
  sheets: { name: string; part: string; hidden: boolean }[];
  date1904: boolean;
  shared: string[];
  /** Style index -> 'date' | 'time' | 'datetime' | 'percent' | undefined. */
  styleKinds: (NumKind | undefined)[];
  parts: ZipParts;
}

type NumKind = 'date' | 'time' | 'datetime' | 'percent';

const BUILTIN_KINDS: Record<number, NumKind> = {
  9: 'percent', 10: 'percent',
  14: 'date', 15: 'date', 16: 'date', 17: 'date', 22: 'datetime',
  18: 'time', 19: 'time', 20: 'time', 21: 'time', 45: 'time', 46: 'time', 47: 'time',
  27: 'date', 28: 'date', 29: 'date', 30: 'date', 31: 'date', 32: 'time', 33: 'time', 34: 'time', 35: 'time', 36: 'date',
  50: 'date', 51: 'date', 52: 'date', 53: 'date', 54: 'date', 55: 'time', 56: 'time', 57: 'date', 58: 'date',
};

/** Classify a custom number format code. */
export function formatKind(code: string): NumKind | undefined {
  const bare = code
    .split(';')[0]!
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, '');
  if (/%/.test(bare)) return 'percent';
  const hasDate = /[dy]/i.test(bare) || /(^|[^h:])m{3,}/i.test(bare);
  const hasTime = /[hs]/i.test(bare) || /AM\/PM/i.test(bare);
  if (hasDate && hasTime) return 'datetime';
  if (hasDate) return 'date';
  if (hasTime) return 'time';
  return undefined;
}

function readWorkbook(bytes: Uint8Array): Workbook {
  const parts = openPackage(bytes, WHAT);
  const wbXml = partText(parts, 'xl/workbook.xml');
  if (wbXml === undefined) throw new ExtractError(`Not a readable ${WHAT} (xl/workbook.xml is missing).`);
  const rels = relationships(parts, 'xl/workbook.xml', WHAT);
  const sheets: Workbook['sheets'] = [];
  let date1904 = false;
  walkXml(
    wbXml,
    {
      open(name, a) {
        if (name === 'workbookPr') date1904 = a.date1904 === '1' || a.date1904 === 'true';
        if (name === 'sheet') {
          const part = rels.get(a['r:id'] ?? '');
          if (part && a.name !== undefined) sheets.push({ name: a.name, part, hidden: !!a.state && a.state !== 'visible' });
        }
      },
    },
    WHAT,
  );

  const shared: string[] = [];
  const ssXml = partText(parts, 'xl/sharedStrings.xml');
  if (ssXml) {
    let cur = '';
    let inT = false;
    let inPh = 0;
    walkXml(
      ssXml,
      {
        open(name) {
          if (name === 'si') cur = '';
          else if (name === 't') inT = true;
          else if (name === 'rPh') inPh++;
        },
        text(t) {
          if (inT && inPh === 0) cur += t;
        },
        close(name) {
          if (name === 't') inT = false;
          else if (name === 'rPh') inPh--;
          else if (name === 'si') shared.push(cur);
        },
      },
      WHAT,
    );
  }

  const styleKinds: (NumKind | undefined)[] = [];
  const stXml = partText(parts, 'xl/styles.xml');
  if (stXml) {
    const custom = new Map<number, NumKind | undefined>();
    let inXfs = false;
    walkXml(
      stXml,
      {
        open(name, a) {
          if (name === 'numFmt') custom.set(Number(a.numFmtId), formatKind(a.formatCode ?? ''));
          else if (name === 'cellXfs') inXfs = true;
          else if (name === 'xf' && inXfs) {
            const id = Number(a.numFmtId ?? 0);
            styleKinds.push(custom.has(id) ? custom.get(id) : BUILTIN_KINDS[id]);
          }
        },
        close(name) {
          if (name === 'cellXfs') inXfs = false;
        },
      },
      WHAT,
    );
  }
  return { sheets, date1904, shared, styleKinds, parts };
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** Excel serial number -> "2026-11-09", "14:30:00" or "2026-11-09 14:30". */
export function serialToText(serial: number, kind: 'date' | 'time' | 'datetime', date1904: boolean): string {
  const ms = Math.round(serial * 86_400_000);
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(base + ms);
  const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const time = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  if (kind === 'time') return time;
  if (kind === 'datetime' || ms % 86_400_000 !== 0) return `${date} ${time.replace(/:00$/, '')}`;
  return date;
}

function numberText(v: string, kind: NumKind | undefined, date1904: boolean): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (kind === 'percent') return `${Number((n * 100).toPrecision(12))}%`;
  if (kind && n >= 0 && n < 2_958_466) return serialToText(n, kind, date1904);
  return String(Number(n.toPrecision(15)));
}

export interface SheetWindow {
  from: number;
  to: number;
  /** Stop keeping rows after roughly this many characters (scanning continues for counts). */
  keepChars: number;
}

export function parseSheet(wb: Workbook, index: number, win: SheetWindow): Grid {
  const sheet = wb.sheets[index]!;
  const xml = partText(wb.parts, sheet.part);
  if (xml === undefined) throw new ExtractError(`Sheet "${sheet.name}" is missing from the workbook (damaged file).`);
  const grid: Grid = { name: sheet.name, rows: [], maxRow: 0, maxCol: 0, rowCount: 0 };
  let kept = 0;
  let rowNum = 0;
  let colNum = 0;
  let cells: string[] = [];
  let rowHas = false;
  let cell: { t?: string; s?: number; v: string; inV: boolean; inIs: boolean; inT: boolean } | undefined;

  const finishRow = () => {
    if (!rowHas) return;
    grid.rowCount++;
    grid.maxRow = Math.max(grid.maxRow, rowNum);
    if (rowNum === 1 || (rowNum >= win.from && rowNum <= win.to)) {
      const line = cells.map((c) => c ?? '');
      if (rowNum === 1 && win.from > 1) grid.header = [1, line];
      if (rowNum >= win.from && rowNum <= win.to) {
        if (kept < win.keepChars) {
          grid.rows.push([rowNum, line]);
          kept += line.reduce((a, c) => a + c.length + 1, 8);
        } else grid.clipped = true;
      }
    }
  };

  walkXml(
    xml,
    {
      open(name, a) {
        if (name === 'row') {
          rowNum = a.r ? Number(a.r) : rowNum + 1;
          colNum = 0;
          cells = [];
          rowHas = false;
        } else if (name === 'c') {
          const ref = a.r ? parseCellRef(a.r) : undefined;
          colNum = ref ? ref.col : colNum + 1;
          cell = { v: '', inV: false, inIs: false, inT: false, ...(a.t ? { t: a.t } : {}), ...(a.s ? { s: Number(a.s) } : {}) };
        } else if (cell) {
          if (name === 'v') cell.inV = true;
          else if (name === 'is') cell.inIs = true;
          else if (name === 't' && cell.inIs) cell.inT = true;
        }
      },
      text(t) {
        if (cell && (cell.inV || cell.inT)) cell.v += t;
      },
      close(name) {
        if (!cell) {
          if (name === 'row') finishRow();
          return;
        }
        if (name === 'v') cell.inV = false;
        else if (name === 't') cell.inT = false;
        else if (name === 'is') cell.inIs = false;
        else if (name === 'c') {
          let text: string;
          switch (cell.t) {
            case 's':
              text = wb.shared[Number(cell.v)] ?? '';
              break;
            case 'b':
              text = cell.v === '1' ? 'TRUE' : cell.v === '0' ? 'FALSE' : cell.v;
              break;
            case 'str':
            case 'inlineStr':
            case 'e':
            case 'd':
              text = cell.v;
              break;
            default:
              text = cell.v === '' ? '' : numberText(cell.v, cell.s !== undefined ? wb.styleKinds[cell.s] : undefined, wb.date1904);
          }
          text = cleanCell(text);
          if (text) {
            cells[colNum - 1] = text;
            rowHas = true;
            grid.maxCol = Math.max(grid.maxCol, colNum);
          }
          cell = undefined;
        }
      },
    },
    WHAT,
  );
  for (const [, line] of grid.rows) for (let i = 0; i < line.length; i++) line[i] ??= '';
  return grid;
}

/** Size from the sheet's <dimension> element, without parsing the rows. Undefined when absent or trivial. */
function quickSize(wb: Workbook, index: number): Pick<Grid, 'name' | 'maxRow' | 'maxCol'> | undefined {
  const bytes = wb.parts[wb.sheets[index]!.part];
  if (!bytes) return undefined;
  const head = new TextDecoder().decode(bytes.subarray(0, 4096));
  const m = /<(?:\w+:)?dimension\s+ref="([A-Z]+\d+):([A-Z]+\d+)"/i.exec(head);
  const end = m ? parseCellRef(m[2]!) : undefined;
  if (!end) return undefined;
  return { name: wb.sheets[index]!.name, maxRow: end.row, maxCol: end.col };
}

export async function extractXlsx(src: SourceFile, req: ExtractRequest, maxChars: number, signal?: AbortSignal): Promise<ExtractResult> {
  const wb = readWorkbook(src.bytes);
  if (wb.sheets.length === 0) throw new ExtractError(`Not a readable ${WHAT} (it lists no sheets).`);
  const names = wb.sheets.map((s) => s.name);
  let targets: number[];
  if (req.sheet !== undefined && req.sheet !== '') {
    const i = pickSheet(names, req.sheet);
    if (i === undefined) {
      throw new ExtractError(`No sheet "${req.sheet}". Sheets: ${names.map((n, k) => `${k + 1} "${n}"`).join(', ')}.`);
    }
    targets = [i];
  } else targets = names.map((_, i) => i);

  const from = Math.max(1, req.offset ?? 1);
  const to = req.limit ? from + req.limit - 1 : Number.MAX_SAFE_INTEGER;
  const budget = new Budget(maxChars - 1500);
  const grids: (Grid | undefined)[] = names.map(() => undefined);
  const out: string[] = [];
  const shownSheets: string[] = [];
  let read: { sheet?: string; rows?: string; range?: string } = {};
  let stopped: { sheet: number; nextRow?: number } | undefined;

  for (const i of targets) {
    if (stopped) break;
    throwIfAborted(signal);
    const g = parseSheet(wb, i, { from, to, keepChars: budget.left });
    grids[i] = g;
    const label = `=== sheet ${i + 1} "${g.name}"${wb.sheets[i]!.hidden ? ' (hidden)' : ''} — ${g.rowCount} rows with data, ${sheetInfo(g).range ?? 'empty'} ===\n`;
    if (g.rowCount === 0) {
      if (budget.take(`${label}(empty sheet)\n`)) out.push(`${label}(empty sheet)\n`);
      continue;
    }
    if (!budget.take(label)) {
      stopped = { sheet: i };
      continue;
    }
    const r = renderGrid(g, from, to, budget);
    out.push(label + r.text + (r.first === undefined ? `(no rows with data in ${from}-${to === Number.MAX_SAFE_INTEGER ? g.maxRow : to})\n` : ''));
    shownSheets.push(g.name);
    if (targets.length === 1 || shownSheets.length === 1) {
      const range = shownRange(g, r);
      read = { sheet: g.name, ...(r.first !== undefined ? { rows: `${r.first}-${r.last}` } : {}), ...(range ? { range } : {}) };
    }
    if (r.more) stopped = { sheet: i, nextRow: (r.last ?? from - 1) + 1 };
  }
  if (shownSheets.length > 1) read = { sheet: shownSheets.join(', ') };

  // Sheets we did not open still need their size for the table of contents.
  const infos = names.map((_, i) => sheetInfo(grids[i] ?? quickSize(wb, i) ?? parseSheet(wb, i, { from: 1, to: 0, keepChars: 0 })));

  const head = `Excel workbook, ${names.length} sheet${names.length === 1 ? '' : 's'}: ${infos
    .map((s, k) => `${k + 1} "${s.name}" (${s.range ?? 'empty'})`)
    .join('; ')}.`;
  const lines = [head, 'Rows are numbered as in Excel; columns are lettered. Cite cells as Sheet!C12.', '', ...out];
  if (stopped) {
    const s = names[stopped.sheet]!;
    const next = stopped.nextRow
      ? `sheet="${s}" offset=${stopped.nextRow}`
      : `sheet="${s}"`;
    lines.push(`[Stopped because of the size limit. Continue with read_file ${next}${req.limit ? ` limit=${req.limit}` : ''}; other sheets: sheet="<name or number>".]`);
  }
  const truncated = stopped !== undefined;
  return {
    text: lines.join('\n').trimEnd(),
    truncated,
    meta: { ...src.metaBase('xlsx'), sheets: infos, read, ...(truncated ? { truncated } : {}) },
  };
}
