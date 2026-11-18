// PDF: text layer via pdf.js (the unpdf build: no worker, no canvas, no native code); pages with little or no text
// (scanned) drawn as pictures by PDFium when the reader asks (pdf-render.ts).
import { getDocumentProxy } from 'unpdf';
import { openDrawer, type PageDrawer } from './pdf-render.ts';
import type { SourceFile } from './source.ts';
import { ExtractError, type ExtractRequest, type ExtractResult, type PageImage } from './types.ts';
import { Budget, formatRanges, parseRanges, throwIfAborted } from './util.ts';

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
}

/** Join pdf.js text items into lines: a new line on hasEOL or when the baseline moves. */
export function joinTextItems(items: readonly unknown[]): string {
  let out = '';
  let lastY: number | undefined;
  for (const raw of items) {
    const it = raw as TextItemLike;
    if (typeof it.str !== 'string') continue;
    const y = it.transform?.[5];
    if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 2 && out !== '' && !out.endsWith('\n')) out += '\n';
    out += it.str;
    if (it.hasEOL) out += '\n';
    if (y !== undefined) lastY = y;
  }
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type PdfDoc = Awaited<ReturnType<typeof getDocumentProxy>>;

async function openPdf(bytes: Uint8Array): Promise<PdfDoc> {
  try {
    // pdf.js takes ownership of the buffer; give it a copy.
    return await getDocumentProxy(new Uint8Array(bytes), {
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'PasswordException') throw new ExtractError('This PDF is password protected; it cannot be read without the password.');
    const msg = err instanceof Error ? err.message : String(err);
    throw new ExtractError(`Not a readable PDF (the file may be damaged or not a PDF): ${msg}`);
  }
}

async function outline(pdf: PdfDoc): Promise<string[]> {
  try {
    const items = (await pdf.getOutline()) ?? [];
    const lines: string[] = [];
    for (const it of items.slice(0, 40)) {
      let page = '';
      try {
        const dest = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest;
        const ref = Array.isArray(dest) ? dest[0] : undefined;
        if (ref && typeof ref === 'object') page = ` (page ${(await pdf.getPageIndex(ref as never)) + 1})`;
      } catch {
        // Destination not resolvable; list the title alone.
      }
      lines.push(`- ${it.title}${page}`);
    }
    return lines;
  } catch {
    return [];
  }
}

/** A page with fewer characters than this (spaces not counted) has "little or no text": probably scanned. */
export const SPARSE_TEXT_CHARS = 40;

function isSparse(text: string): boolean {
  return text.replace(/\s/g, '').length < SPARSE_TEXT_CHARS;
}

/** Draw `pages` with PDFium; the pictures, and the reason when none could be drawn. */
async function drawPages(bytes: Uint8Array, pages: number[], signal?: AbortSignal): Promise<{ images: PageImage[]; failed?: string }> {
  if (pages.length === 0) return { images: [] };
  let drawer: PageDrawer;
  try {
    drawer = await openDrawer(new Uint8Array(bytes));
  } catch (err) {
    return { images: [], failed: err instanceof Error ? err.message : String(err) };
  }
  const images: PageImage[] = [];
  try {
    for (const n of pages) {
      throwIfAborted(signal);
      try {
        images.push(drawer.draw(n));
      } catch {
        // this page alone: said below as not drawn
      }
      // let other conversations' work run between pages
      await new Promise<void>((r) => setImmediate(r));
    }
  } finally {
    drawer.close();
  }
  return { images, ...(images.length === 0 ? { failed: 'PDFium could not draw these pages' } : {}) };
}

export async function extractPdf(src: SourceFile, req: ExtractRequest, maxChars: number, signal?: AbortSignal): Promise<ExtractResult> {
  const pdf = await openPdf(src.bytes);
  try {
    const total = pdf.numPages;
    const wanted = req.pages ? parseRanges(req.pages, total, 'page') : Array.from({ length: total }, (_, i) => i + 1);
    const head = `PDF, ${total} page${total === 1 ? '' : 's'}.`;
    const budget = new Budget(maxChars - head.length - 600);
    const drawing = req.pageImages !== undefined;
    const shown: number[] = [];
    const blank: number[] = [];
    const sparse: number[] = [];
    const body: string[] = [];
    let cutPage: number | undefined;
    let stoppedAt: number | undefined;
    for (const n of wanted) {
      throwIfAborted(signal);
      const page = await pdf.getPage(n);
      const text = joinTextItems((await page.getTextContent()).items);
      page.cleanup();
      if (!text) blank.push(n);
      const little = drawing && isSparse(text);
      const mark = text ? (little ? `${text}\n[little text on this page]` : text) : '[no text layer on this page]';
      const block = `=== page ${n} ===\n${mark}\n`;
      if (budget.take(block)) {
        body.push(block);
        shown.push(n);
        if (little) sparse.push(n);
        continue;
      }
      if (shown.length === 0) {
        // A single page larger than the cap: return its beginning.
        const room = Math.max(0, budget.left - 80);
        body.push(`=== page ${n} ===\n${text.slice(0, room)}\n[page ${n} cut at ${room} of ${text.length} characters]\n`);
        shown.push(n);
        cutPage = n;
      }
      stoppedAt = n;
      break;
    }
    const noTextLayer = blank.length === total;
    const rest = stoppedAt === undefined ? [] : wanted.filter((n) => n >= stoppedAt! && n !== cutPage);

    // Scanned pages as pictures, up to the number asked for; the rest are named for the next call.
    const cap = Math.max(0, req.pageImages ?? 0);
    const drawn = cap > 0 ? await drawPages(src.bytes, sparse.slice(0, cap), signal) : { images: [] as PageImage[] };
    const drawnPages = drawn.images.map((p) => p.page);
    const notDrawn = sparse.filter((n) => !drawnPages.includes(n));
    const truncated = rest.length > 0 || cutPage !== undefined || (cap > 0 && notDrawn.length > 0 && !drawn.failed);

    const lines = [head];
    if (noTextLayer && !drawing) {
      lines.push(
        'This PDF has no text layer on any page (it is probably scanned images). No text can be extracted; OCR is not available.',
      );
    } else {
      lines.push(`Showing page${shown.length === 1 ? '' : 's'} ${formatRanges(shown)} of ${total}.`);
      if (!drawing && blank.length > 0 && blank.length < total) lines.push(`Pages without a text layer: ${formatRanges(blank)}.`);
      if (sparse.length > 0) {
        lines.push(`Pages with little or no text (probably scanned): ${formatRanges(sparse)}.`);
        if (cap === 0) lines.push('The current model does not take images, so these pages cannot be shown as pictures.');
        else if (drawn.failed) lines.push(`They could not be drawn as pictures: ${drawn.failed}.`);
        else {
          if (drawnPages.length > 0) lines.push(`Pages ${formatRanges(drawnPages)} follow as pictures.`);
          if (notDrawn.length > 0) {
            lines.push(
              `Not drawn (at most ${cap} pictures per call): pages ${formatRanges(notDrawn)}. Call read_file again with pages="${formatRanges(notDrawn.slice(0, cap)).replace(/ /g, '')}" to see them.`,
            );
          }
        }
      }
      lines.push('', ...body);
      if (rest.length > 0) {
        lines.push(`[Stopped because of the size limit. Not shown: pages ${formatRanges(rest)}. Call read_file again with pages="…" to read them.]`);
        const toc = await outline(pdf);
        if (toc.length > 0) lines.push('Outline:', ...toc);
      }
    }
    return {
      text: lines.join('\n').trimEnd(),
      truncated,
      meta: {
        ...src.metaBase('pdf'),
        pageCount: total,
        read: { pages: formatRanges(shown) },
        ...(truncated ? { truncated } : {}),
        ...(noTextLayer ? { noTextLayer } : {}),
      },
      ...(drawn.images.length > 0 ? { pageImages: drawn.images } : {}),
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
