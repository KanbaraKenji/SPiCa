// PDF pages drawn as pictures, for pages with no text layer (scanned pages): PDFium compiled to WebAssembly
// (@embedpdf/pdfium; no native code, nothing to install). The .wasm file is found in the package (development,
// tests) or where the host put it (setPdfiumWasm: a bundled app carries it as a file of its own).
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';

/** Long side of a drawn page in pixels: the core's IMAGE_LIMITS.maxLongSide (an A4 page comes out 1109 x 1568). */
export const RENDER_LONG_SIDE = 1568;

let wasmPath: string | undefined;
let loading: Promise<WrappedPdfiumModule> | undefined;

/** Where pdfium.wasm is (a bundled app, where the package's own copy is not on disk). */
export function setPdfiumWasm(path: string): void {
  wasmPath = path;
  loading = undefined;
}

function pdfium(): Promise<WrappedPdfiumModule> {
  if (!loading) {
    const started = (async () => {
      const path = wasmPath ?? createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm');
      const bin = await readFile(path);
      const m = await init({ wasmBinary: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer });
      m.PDFiumExt_Init();
      return m;
    })();
    // a failed load is tried again next time (the file may be back)
    started.catch(() => {
      if (loading === started) loading = undefined;
    });
    loading = started;
  }
  return loading;
}

export interface DrawnPage {
  page: number;
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, opaque. */
  rgba: Uint8Array;
  /** A part of the page (drawRegion): the whole page's size at the scale it was drawn. */
  whole?: { width: number; height: number };
}

/** A part of a page, as fractions of its width and height (0-1, from the top left). */
export interface PageRegion {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Largest long side the whole page may have when a part of it is drawn (about 2,400 dpi for an A4 page). */
export const REGION_MAX_PAGE_SIDE = 28_000;

/** FPDF_ANNOT: draw annotations (stamps, filled-in forms); FPDF_REVERSE_BYTE_ORDER: RGBA instead of BGRA. */
const FLAGS = 0x01 | 0x10;

/** A PDF opened for drawing pages; close() frees it. */
export interface PageDrawer {
  draw(page: number, longSide?: number): DrawnPage;
  /** Only `region` of the page, drawn so that its long side is `longSide` (less when the page would get too large). */
  drawRegion(page: number, region: PageRegion, longSide?: number): DrawnPage;
  close(): void;
}

export async function openDrawer(bytes: Uint8Array): Promise<PageDrawer> {
  const m = await pdfium();
  const mod = m.pdfium;
  // Emscripten's memory view (typed in @types/emscripten, which is not installed); replaced when memory grows
  const heap = () => (mod as unknown as { HEAPU8: Uint8Array }).HEAPU8;
  const ptr = mod.wasmExports.malloc(bytes.length);
  heap().set(bytes, ptr);
  const doc = m.FPDF_LoadMemDocument(ptr, bytes.length, '');
  if (!doc) {
    mod.wasmExports.free(ptr);
    throw new Error(`PDFium could not open the file (error ${m.FPDF_GetLastError()})`);
  }
  /** Draw page n at `scale` pixels per point, the part from (x, y) of size width x height pixels. */
  const render = (n: number, scaleFor: (w: number, h: number) => number, part: (W: number, H: number) => { x: number; y: number; width: number; height: number }): DrawnPage => {
    const page = m.FPDF_LoadPage(doc, n - 1);
    if (!page) throw new Error(`PDFium could not open page ${n}`);
    try {
      // points, with the page's rotation applied
      const w = m.FPDF_GetPageWidthF(page);
      const h = m.FPDF_GetPageHeightF(page);
      const scale = scaleFor(w, h);
      const W = Math.max(1, Math.round(w * scale));
      const H = Math.max(1, Math.round(h * scale));
      const { x, y, width, height } = part(W, H);
      const bmp = m.FPDFBitmap_Create(width, height, 0);
      if (!bmp) throw new Error(`no memory for a ${width}x${height} picture`);
      try {
        m.FPDFBitmap_FillRect(bmp, 0, 0, width, height, 0xffffffff);
        // the whole page at W x H, moved so that the part lands on the bitmap (PDFium clips the rest)
        m.FPDF_RenderPageBitmap(bmp, page, -x, -y, W, H, 0, FLAGS);
        const buf = m.FPDFBitmap_GetBuffer(bmp);
        const stride = m.FPDFBitmap_GetStride(bmp);
        const mem = heap(); // read after drawing: memory may have grown
        const rgba = new Uint8Array(width * height * 4);
        for (let r = 0; r < height; r++) rgba.set(mem.subarray(buf + r * stride, buf + r * stride + width * 4), r * width * 4);
        for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
        return { page: n, width, height, rgba, ...(width !== W || height !== H ? { whole: { width: W, height: H } } : {}) };
      } finally {
        m.FPDFBitmap_Destroy(bmp);
      }
    } finally {
      m.FPDF_ClosePage(page);
    }
  };
  return {
    draw(n, longSide = RENDER_LONG_SIDE) {
      return render(n, (w, h) => longSide / Math.max(w, h, 1), (W, H) => ({ x: 0, y: 0, width: W, height: H }));
    },
    drawRegion(n, r, longSide = RENDER_LONG_SIDE) {
      return render(
        n,
        (w, h) => {
          const partLong = Math.max((r.right - r.left) * w, (r.bottom - r.top) * h, 1e-6);
          return Math.min(longSide / partLong, REGION_MAX_PAGE_SIDE / Math.max(w, h, 1));
        },
        (W, H) => {
          const x = Math.min(W - 1, Math.floor(r.left * W));
          const y = Math.min(H - 1, Math.floor(r.top * H));
          return { x, y, width: Math.max(1, Math.min(W, Math.ceil(r.right * W)) - x), height: Math.max(1, Math.min(H, Math.ceil(r.bottom * H)) - y) };
        },
      );
    },
    close() {
      m.FPDF_CloseDocument(doc);
      mod.wasmExports.free(ptr);
    },
  };
}
