// Word (.docx): paragraphs, headings, lists and tables from word/document.xml.
// Blocks (non-empty paragraphs and tables) are numbered so the model can page with offset/limit.
import { openPackage, partText, walkXml, type ZipParts } from './ooxml.ts';
import type { SourceFile } from './source.ts';
import { ExtractError, type ExtractRequest, type ExtractResult } from './types.ts';
import { Budget, oneLine } from './util.ts';

export type DocBlock =
  | { type: 'p'; text: string; heading?: number; list?: number }
  | { type: 'table'; rows: string[][] };

function headingStyles(parts: ZipParts): Map<string, number> {
  const map = new Map<string, number>();
  const xml = partText(parts, 'word/styles.xml');
  if (!xml) return map;
  let id: string | undefined;
  let level: number | undefined;
  walkXml(
    xml,
    {
      open(name, a) {
        if (name === 'w:style') {
          id = a['w:styleId'];
          level = undefined;
        } else if (name === 'w:name' && id) {
          const n = (a['w:val'] ?? '').toLowerCase();
          const m = /^heading (\d)$/.exec(n);
          if (m) level = Number(m[1]);
          else if (n === 'title') level = 1;
        } else if (name === 'w:outlineLvl' && id && level === undefined) {
          const v = Number(a['w:val']);
          if (v >= 0 && v < 9) level = v + 1;
        }
      },
      close(name) {
        if (name === 'w:style' && id && level !== undefined) map.set(id, level);
      },
    },
    'Word document',
  );
  return map;
}

export function parseDocx(bytes: Uint8Array): DocBlock[] {
  const parts = openPackage(bytes, 'Word document');
  const xml = partText(parts, 'word/document.xml');
  if (xml === undefined) throw new ExtractError('Not a readable Word document (word/document.xml is missing).');
  const headings = headingStyles(parts);
  const blocks: DocBlock[] = [];

  let tblDepth = 0;
  let rows: string[][] = [];
  let row: string[] | undefined;
  let cell: string[] | undefined;
  let para: { text: string; style?: string; outline?: number; list?: number } | undefined;
  let inRun = false;
  let inText = false;
  let inPPr = false;

  walkXml(
    xml,
    {
      open(name, a) {
        switch (name) {
          case 'w:tbl':
            tblDepth++;
            if (tblDepth === 1) rows = [];
            break;
          case 'w:tr':
            if (tblDepth === 1) row = [];
            break;
          case 'w:tc':
            if (tblDepth === 1) cell = [];
            break;
          case 'w:p':
            para = { text: '' };
            break;
          case 'w:pPr':
            inPPr = true;
            break;
          case 'w:pStyle':
            if (para && inPPr && a['w:val']) para.style = a['w:val'];
            break;
          case 'w:outlineLvl':
            if (para && inPPr) para.outline = Number(a['w:val']);
            break;
          case 'w:ilvl':
            if (para && inPPr) para.list = Number(a['w:val']) || 0;
            break;
          case 'w:numPr':
            if (para && inPPr) para.list ??= 0;
            break;
          case 'w:r':
            inRun = true;
            break;
          case 'w:t':
            inText = true;
            break;
          case 'w:tab':
            if (inRun && para) para.text += '\t';
            break;
          case 'w:br':
          case 'w:cr':
            if (inRun && para) para.text += '\n';
            break;
          case 'w:noBreakHyphen':
            if (inRun && para) para.text += '-';
            break;
        }
      },
      text(t) {
        if (inText && para) para.text += t;
      },
      close(name) {
        switch (name) {
          case 'w:t':
            inText = false;
            break;
          case 'w:r':
            inRun = false;
            break;
          case 'w:pPr':
            inPPr = false;
            break;
          case 'w:p': {
            const p = para;
            para = undefined;
            if (!p) break;
            const text = p.text.replace(/[ \t]+$/gm, '').trim();
            if (tblDepth > 0) {
              if (text && cell) cell.push(text);
              break;
            }
            if (!text) break;
            const level = (p.style ? headings.get(p.style) : undefined) ?? (p.outline !== undefined && p.outline < 9 ? p.outline + 1 : undefined);
            blocks.push({ type: 'p', text, ...(level ? { heading: level } : {}), ...(p.list !== undefined && !level ? { list: p.list } : {}) });
            break;
          }
          case 'w:tc':
            if (tblDepth === 1 && row && cell) row.push(oneLine(cell.join(' / ')));
            if (tblDepth === 1) cell = undefined;
            break;
          case 'w:tr':
            if (tblDepth === 1 && row) rows.push(row);
            if (tblDepth === 1) row = undefined;
            break;
          case 'w:tbl':
            tblDepth--;
            if (tblDepth === 0 && rows.some((r) => r.some((c) => c))) blocks.push({ type: 'table', rows });
            break;
        }
      },
    },
    'Word document',
  );
  return blocks;
}

function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

export function renderBlock(b: DocBlock, n: number, tableNo: number): string {
  if (b.type === 'p') {
    const text = b.text.replace(/\n/g, '\n    ');
    if (b.heading) return `[${n}] ${'#'.repeat(Math.min(b.heading, 6))} ${text}`;
    if (b.list !== undefined) return `[${n}] ${'  '.repeat(b.list)}- ${text}`;
    return `[${n}] ${text}`;
  }
  const cols = Math.max(...b.rows.map((r) => r.length));
  const lines = [`[${n}] Table ${tableNo} (${b.rows.length} rows × ${cols} columns):`];
  b.rows.forEach((r, i) => {
    const cells = Array.from({ length: cols }, (_, j) => mdCell(r[j] ?? ''));
    lines.push(`    | ${cells.join(' | ')} |`);
    if (i === 0) lines.push(`    |${' --- |'.repeat(cols)}`);
  });
  return lines.join('\n');
}

export async function extractDocx(src: SourceFile, req: ExtractRequest, maxChars: number): Promise<ExtractResult> {
  const blocks = parseDocx(src.bytes);
  const tables = blocks.filter((b) => b.type === 'table').length;
  const paras = blocks.length - tables;
  const head = `Word document: ${paras} paragraph${paras === 1 ? '' : 's'} and ${tables} table${tables === 1 ? '' : 's'} (${blocks.length} numbered blocks).`;
  const base = { ...src.metaBase('docx'), blockCount: blocks.length };
  if (blocks.length === 0) {
    return { text: `${head}\nThe document has no text.`, meta: { ...base, read: {} } };
  }
  const start = Math.min(Math.max(1, req.offset ?? 1), blocks.length);
  const end = Math.min(blocks.length, req.limit ? start + req.limit - 1 : blocks.length);
  // Room for the headings outline of the parts not shown.
  const tocMax = Math.min(4000, Math.floor(maxChars / 5));
  const budget = new Budget(maxChars - head.length - 300 - tocMax);
  const out: string[] = [];
  let last = start - 1;
  let tableNo = blocks.slice(0, start - 1).filter((b) => b.type === 'table').length;
  for (let i = start; i <= end; i++) {
    const b = blocks[i - 1]!;
    if (b.type === 'table') tableNo++;
    let s = `${renderBlock(b, i, tableNo)}\n`;
    if (!budget.take(s)) {
      if (out.length > 0) break;
      s = `${s.slice(0, Math.max(0, budget.left - 60))}\n[block ${i} cut because of the size limit]\n`;
      budget.take(s);
      out.push(s);
      last = i;
      break;
    }
    out.push(s);
    last = i;
  }
  const truncated = last < end || out.at(-1)?.includes('cut because of the size limit') === true;
  const lines = [head, `Showing blocks ${start}-${last} of ${blocks.length}.`, '', out.join('').trimEnd()];
  if (last < end) {
    lines.push(`[Stopped because of the size limit. Call read_file again with offset=${last + 1} to continue.]`);
  }
  // Outline of the headings that were not shown, so the model can jump with offset.
  const toc = blocks
    .map((b, i) => (b.type === 'p' && b.heading && (i + 1 < start || i + 1 > last) ? `${'  '.repeat(b.heading - 1)}- [${i + 1}] ${oneLine(b.text).slice(0, 80)}` : ''))
    .filter(Boolean);
  if (toc.length > 0) {
    const room = new Budget(tocMax - 60);
    const kept: string[] = [];
    for (const t of toc) {
      if (!room.take(`${t}\n`)) break;
      kept.push(t);
    }
    lines.push('Headings not shown (block numbers):', ...kept, ...(kept.length < toc.length ? [`… ${toc.length - kept.length} more`] : []));
  }
  return {
    text: lines.join('\n').trimEnd(),
    truncated,
    meta: { ...base, read: { blocks: `${start}-${last}` }, ...(truncated ? { truncated } : {}) },
  };
}
