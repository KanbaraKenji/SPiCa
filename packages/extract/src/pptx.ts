// PowerPoint (.pptx): text of each slide (shapes in document order, tables as rows) and speaker notes.
import { openPackage, partText, relationships, walkXml } from './ooxml.ts';
import type { SourceFile } from './source.ts';
import { ExtractError, type ExtractRequest, type ExtractResult } from './types.ts';
import { Budget, formatRanges, oneLine, parseRanges, throwIfAborted } from './util.ts';

const WHAT = 'PowerPoint file';

/** Paragraphs of one slide XML; table rows become "a | b | c". */
function slideParagraphs(xml: string): string[] {
  const out: string[] = [];
  let para: string | undefined;
  let inT = false;
  let row: string[] | undefined;
  let cell: string[] | undefined;
  walkXml(
    xml,
    {
      open(name) {
        if (name === 'a:tr') row = [];
        else if (name === 'a:tc') cell = [];
        else if (name === 'a:p') para = '';
        else if (name === 'a:t') inT = true;
        else if (name === 'a:br' && para !== undefined) para += '\n';
      },
      text(t) {
        if (inT && para !== undefined) para += t;
      },
      close(name) {
        if (name === 'a:t') inT = false;
        else if (name === 'a:p') {
          const p = (para ?? '').trim();
          para = undefined;
          if (!p) return;
          if (cell) cell.push(p);
          else out.push(p);
        } else if (name === 'a:tc') {
          if (row && cell) row.push(oneLine(cell.join(' / ')));
          cell = undefined;
        } else if (name === 'a:tr') {
          if (row && row.some(Boolean)) out.push(`| ${row.join(' | ')} |`);
          row = undefined;
        }
      },
    },
    WHAT,
  );
  return out;
}

export async function extractPptx(src: SourceFile, req: ExtractRequest, maxChars: number, signal?: AbortSignal): Promise<ExtractResult> {
  const parts = openPackage(src.bytes, WHAT);
  const presXml = partText(parts, 'ppt/presentation.xml');
  if (presXml === undefined) throw new ExtractError(`Not a readable ${WHAT} (ppt/presentation.xml is missing).`);
  const rels = relationships(parts, 'ppt/presentation.xml', WHAT);
  const slideParts: string[] = [];
  walkXml(
    presXml,
    {
      open(name, a) {
        if (name === 'p:sldId') {
          const part = rels.get(a['r:id'] ?? '');
          if (part) slideParts.push(part);
        }
      },
    },
    WHAT,
  );
  const total = slideParts.length;
  const head = `PowerPoint, ${total} slide${total === 1 ? '' : 's'}.`;
  const base = { ...src.metaBase('pptx'), slideCount: total };
  if (total === 0) return { text: `${head}\nThe presentation has no slides.`, meta: base };

  const wanted = req.pages ? parseRanges(req.pages, total, 'slide') : Array.from({ length: total }, (_, i) => i + 1);
  const budget = new Budget(maxChars - 400);
  const body: string[] = [];
  const shown: number[] = [];
  let stoppedAt: number | undefined;
  for (const n of wanted) {
    throwIfAborted(signal);
    const part = slideParts[n - 1]!;
    const xml = partText(parts, part);
    const paras = xml ? slideParagraphs(xml) : [];
    let notes: string[] = [];
    for (const target of relationships(parts, part, WHAT).values()) {
      if (/notesSlide\d*\.xml$/.test(target)) {
        const nx = partText(parts, target);
        // Notes slides repeat the slide number placeholder as text; drop bare numbers.
        if (nx) notes = slideParagraphs(nx).filter((p) => !/^\d+$/.test(p));
      }
    }
    let block = `=== slide ${n} ===\n${paras.length ? paras.join('\n') : '[no text on this slide]'}\n`;
    if (notes.length) block += `Notes: ${notes.join('\n')}\n`;
    if (!budget.take(block)) {
      stoppedAt = n;
      break;
    }
    body.push(block);
    shown.push(n);
  }
  const rest = stoppedAt === undefined ? [] : wanted.filter((n) => n >= stoppedAt!);
  const lines = [head, `Showing slide${shown.length === 1 ? '' : 's'} ${shown.length ? formatRanges(shown) : 'none'} of ${total}.`, '', ...body];
  if (rest.length) lines.push(`[Stopped because of the size limit. Not shown: slides ${formatRanges(rest)}. Call read_file again with pages="…".]`);
  const truncated = rest.length > 0;
  return {
    text: lines.join('\n').trimEnd(),
    truncated,
    meta: { ...base, read: shown.length ? { pages: formatRanges(shown) } : {}, ...(truncated ? { truncated } : {}) },
  };
}
