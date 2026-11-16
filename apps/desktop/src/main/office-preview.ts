// Word and Excel in the right panel, read with @spica/extract (the core reads them the same way for the model):
// a Word document as Markdown (headings, lists, tables), an Excel sheet as a grid with Excel's row numbers and
// column letters. Neither shows fonts, colours or pictures: a plugin preview page can (设置 › 常规 › 文件预览),
// and 用系统程序打开 is always there.
import { extractFile } from '@spica/extract';
import type { PreviewInfo } from '../shared/bridge';
import { t } from '../shared/i18n';

export const WORD = new Set(['.docx', '.docm']);
export const EXCEL = new Set(['.xlsx', '.xlsm']);
/** Rows of a sheet and blocks of a document shown at most. */
const ROWS = 500;

/** What the panel says for a file it cannot read (the error from stat, open or the extractor; here as preview.ts needs it too). */
export function unreadable(err: unknown): { kind: 'missing' | 'unsupported'; message: string } {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing', message: t('找不到文件，可能已被移动或删除。') };
  if (code === 'EACCES' || code === 'EPERM') return { kind: 'unsupported', message: t('没有权限读取此文件。') };
  return { kind: 'unsupported', message: t('无法读取此文件。') };
}

/** The extractor's numbered blocks ("[3] text", tables indented under "[8] Table 1 (…):") as plain Markdown. */
export function docxMarkdown(text: string): string {
  const out: string[] = [];
  let started = false;
  for (const line of text.split('\n')) {
    const block = /^\[\d+\] (.*)$/.exec(line);
    if (block) {
      started = true;
      if (/^Table \d+ \(/.test(block[1]!)) continue;
      // List items stay together; everything else is a paragraph of its own.
      const item = /^(- |\d+\. )/;
      if (!(item.test(block[1]!) && item.test(out[out.length - 1] ?? ''))) out.push('');
      out.push(block[1]!);
      continue;
    }
    if (!started) continue;
    if (/^ {4}\|/.test(line)) {
      if (!out[out.length - 1]?.startsWith('|')) out.push('');
      out.push(line.slice(4));
      continue;
    }
    if (/^\[Stopped|^Headings not shown/.test(line)) break;
  }
  return out.join('\n').trim();
}

/** The grid the extractor lays out ("row\tA\tB…", then "12\tcell\tcell…"). */
export function sheetGrid(text: string): { columns: string[]; rows: { n: number; cells: string[] }[] } {
  const lines = text.split('\n');
  const head = lines.findIndex((l) => l.startsWith('row\t'));
  if (head < 0) return { columns: [], rows: [] };
  const columns = lines[head]!.split('\t').slice(1);
  const rows: { n: number; cells: string[] }[] = [];
  for (const raw of lines.slice(head + 1)) {
    const line = raw.replace(/^\(header\) /, '');
    const m = /^(\d+)\t(.*)$/.exec(line);
    if (!m) break;
    rows.push({ n: Number(m[1]), cells: m[2]!.split('\t') });
  }
  return { columns, rows };
}

/** A Word or Excel file as the panel shows it; `sheet`: which sheet of a workbook (1-based). */
export async function officePreview(path: string, name: string, size: number, ext: string, sheet = 1): Promise<PreviewInfo> {
  try {
    if (WORD.has(ext)) {
      const r = await extractFile(path, { limit: ROWS });
      // The extractor stops at ROWS blocks or at its size limit, whichever comes first; it reports which it showed.
      const total = r.meta.blockCount ?? 0;
      const shown = Number(/-(\d+)$/.exec(r.meta.read?.blocks ?? '')?.[1] ?? total);
      const cut = shown < total || Boolean(r.truncated);
      return { kind: 'markdown', name, path, size, text: docxMarkdown(r.text), truncated: cut, ...(cut ? { blocks: { shown, total } } : {}) };
    }
    const r = await extractFile(path, { sheet: String(sheet), limit: ROWS });
    const sheets = (r.meta.sheets ?? []).map((s) => ({ name: s.name, rows: s.rows, cols: s.cols }));
    const grid = sheetGrid(r.text);
    const shown = sheets[sheet - 1];
    return { kind: 'sheet', name, path, size, sheets, sheet, ...grid, truncated: shown !== undefined && shown.rows > grid.rows.length };
  } catch (err) {
    return { ...unreadable(err), name, path, size };
  }
}
