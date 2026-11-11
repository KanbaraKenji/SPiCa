// A table in an answer as data: copied for Excel (tab-separated text plus an HTML table, so it pastes as
// cells) and exported as CSV.

/** The cells' text, row by row, header first. */
export function tableRows(table: HTMLTableElement): string[][] {
  return [...table.rows].map((r) => [...r.cells].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()));
}

/** Tab-separated lines (what Excel puts on the clipboard); a cell with a tab, line break or quote is quoted. */
export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[\t\r\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join('\t')).join('\r\n');
}

/** CSV (RFC 4180): comma-separated, CRLF lines; a cell with a comma, line break or quote is quoted. */
export function toCsv(rows: string[][]): string {
  return `${rows.map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n')}\r\n`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A plain HTML table of the same cells (no styles or classes), the first row as the header. */
export function toHtml(rows: string[][]): string {
  const row = (r: string[], tag: 'th' | 'td') => `<tr>${r.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join('')}</tr>`;
  const [head, ...body] = rows;
  return `<table>${head ? `<thead>${row(head, 'th')}</thead>` : ''}<tbody>${body.map((r) => row(r, 'td')).join('')}</tbody></table>`;
}
