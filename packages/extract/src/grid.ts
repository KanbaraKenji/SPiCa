// Tables (Excel sheets, CSV) laid out for the model: row numbers + column letters,
// so answers can cite cells like 库存!C12.
import type { SheetInfo } from './types.ts';
import { Budget, colName } from './util.ts';

const MAX_CELL_CHARS = 500;

export interface Grid {
  name: string;
  /** Kept rows in the requested window, sorted; cells[0] is column A. */
  rows: [number, string[]][];
  /** First row (usually the header), kept even when the window starts later. */
  header?: [number, string[]];
  /** Highest row / column that has content in the whole sheet. */
  maxRow: number;
  maxCol: number;
  /** Rows with content in the whole sheet. */
  rowCount: number;
  /** The window was larger than what we kept (memory guard). */
  clipped?: boolean;
}

export function sheetInfo(g: Pick<Grid, 'name' | 'maxRow' | 'maxCol'>): SheetInfo {
  return {
    name: g.name,
    rows: g.maxRow,
    cols: g.maxCol,
    ...(g.maxRow > 0 && g.maxCol > 0 ? { range: `A1:${colName(g.maxCol)}${g.maxRow}` } : {}),
  };
}

export function cleanCell(s: string): string {
  const t = s.replace(/[\t\r\n]+/g, ' ').trim();
  return t.length > MAX_CELL_CHARS ? `${t.slice(0, MAX_CELL_CHARS)}…` : t;
}

function rowLine(n: number, cells: string[]): string {
  let end = cells.length;
  while (end > 0 && !cells[end - 1]) end--;
  return `${n}\t${cells.slice(0, end).join('\t')}\n`;
}

export interface GridRender {
  text: string;
  /** Row numbers actually shown, first..last; undefined when none. */
  first?: number;
  last?: number;
  /** Rows in the window that did not fit. */
  more: boolean;
}

/**
 * Lay out rows [from..to] of a grid within the budget.
 * The caller decides the window; this stops early when the budget runs out.
 */
export function renderGrid(g: Grid, from: number, to: number, budget: Budget): GridRender {
  const cols = Math.max(1, g.maxCol);
  let text = `row\t${Array.from({ length: cols }, (_, i) => colName(i + 1)).join('\t')}\n`;
  if (g.header && g.header[0] < from) text += rowLine(g.header[0], g.header[1]).replace(/^/, '(header) ');
  if (!budget.take(text)) return { text: '', more: true };
  let first: number | undefined;
  let last: number | undefined;
  let more = false;
  for (const [n, cells] of g.rows) {
    if (n < from || n > to) continue;
    const line = rowLine(n, cells);
    if (!budget.take(line)) {
      more = true;
      break;
    }
    text += line;
    first ??= n;
    last = n;
  }
  if (!more && g.clipped && last !== undefined && last < Math.min(to, g.maxRow)) more = true;
  return { text, ...(first !== undefined ? { first } : {}), ...(last !== undefined ? { last } : {}), more };
}

/** "A1:F50" for the rows shown. */
export function shownRange(g: Grid, r: GridRender): string | undefined {
  if (r.first === undefined || r.last === undefined || g.maxCol === 0) return undefined;
  return `A${r.first}:${colName(g.maxCol)}${r.last}`;
}

/** Resolve a sheet request: exact name (case-insensitive) or a 1-based index. */
export function pickSheet(names: readonly string[], want: string): number | undefined {
  const byName = names.findIndex((n) => n.toLowerCase() === want.trim().toLowerCase());
  if (byName >= 0) return byName;
  if (/^\d+$/.test(want.trim())) {
    const i = Number(want.trim()) - 1;
    if (i >= 0 && i < names.length) return i;
  }
  return undefined;
}
