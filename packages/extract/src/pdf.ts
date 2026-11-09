// PDF: text layer via pdf.js (the unpdf build: no worker, no canvas, no native code).
import { getDocumentProxy } from 'unpdf';
import type { SourceFile } from './source.ts';
import { ExtractError, type ExtractRequest, type ExtractResult } from './types.ts';
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

export async function extractPdf(src: SourceFile, req: ExtractRequest, maxChars: number, signal?: AbortSignal): Promise<ExtractResult> {
  const pdf = await openPdf(src.bytes);
  try {
    const total = pdf.numPages;
    const wanted = req.pages ? parseRanges(req.pages, total, 'page') : Array.from({ length: total }, (_, i) => i + 1);
    const head = `PDF, ${total} page${total === 1 ? '' : 's'}.`;
    const budget = new Budget(maxChars - head.length - 400);
    const shown: number[] = [];
    const blank: number[] = [];
    const body: string[] = [];
    let cutPage: number | undefined;
    let stoppedAt: number | undefined;
    for (const n of wanted) {
      throwIfAborted(signal);
      const page = await pdf.getPage(n);
      const text = joinTextItems((await page.getTextContent()).items);
      page.cleanup();
      if (!text) blank.push(n);
      const block = `=== page ${n} ===\n${text || '[no text layer on this page]'}\n`;
      if (budget.take(block)) {
        body.push(block);
        shown.push(n);
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
    const truncated = rest.length > 0 || cutPage !== undefined;

    const lines = [head];
    if (noTextLayer) {
      lines.push(
        'This PDF has no text layer on any page (it is probably scanned images). No text can be extracted; OCR is not available.',
      );
    } else {
      lines.push(`Showing page${shown.length === 1 ? '' : 's'} ${formatRanges(shown)} of ${total}.`);
      if (blank.length > 0 && blank.length < total) lines.push(`Pages without a text layer: ${formatRanges(blank)}.`);
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
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
