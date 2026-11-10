// Images attached to a message (pasted screenshots, dropped pictures): what
// kind they are, how big, a smaller copy when they exceed the limits, and how
// many tokens they take. Zero dependencies: PNG is decoded and encoded here
// (node:zlib); JPEG, GIF and WEBP are measured but not re-encoded, so one of
// those over the limits is refused (the window can hand them over as PNG).
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { IMAGE_LIMITS } from '@spica/protocol';

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** The limits (protocol IMAGE_LIMITS): the strictest of the documented ones, see IMAGE_LIMIT_SOURCES. */
export { IMAGE_LIMITS };

/** Where the limits and the token estimates come from (official pages; checked dates). */
export const IMAGE_LIMIT_SOURCES: { what: string; source: string; checked: string }[] = [
  {
    what: 'Anthropic: base64 image JSON; 10 MB per image (base64); 8000 px max; long side up to 2576 px on current models (1568 px on earlier ones), larger ones scaled; tokens ceil(w/28) x ceil(h/28); stricter sizes with more than 20 images',
    source: 'https://platform.claude.com/docs/en/build-with-claude/vision',
    checked: '2026-11-10',
  },
  {
    what: 'OpenAI: image_url with a data URL; tokens ceil(w/32) x ceil(h/32) times a model factor (1.2 for gpt-6-astra); 30,000 patches per image at most',
    source: 'https://developers.openai.com/api/docs/guides/images-vision',
    checked: '2026-11-10',
  },
  {
    what: 'Gemini (OpenAI-compatible endpoint): image_url data URLs accepted; 20 MB inline data per request; 1,120 tokens per image by default for Gemini 3 and 4; no GIF',
    source: 'https://aistudio.google.com/docs/media-resolution',
    checked: '2026-11-10',
  },
];

export interface ImageInfo {
  mediaType: ImageMediaType;
  width: number;
  height: number;
  bytes: number;
}

/** What kind of image the bytes are (by their signature), or undefined. */
export function sniffImage(head: Buffer): ImageMediaType | undefined {
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && head.toString('latin1', 0, 6).match(/^GIF8[79]a$/)) return 'image/gif';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

/** Width and height from the file's header (no decoding), or undefined when it cannot be read. */
export function imageSize(buf: Buffer, type: ImageMediaType): { width: number; height: number } | undefined {
  try {
    if (type === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (type === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (type === 'image/webp') {
      const kind = buf.toString('latin1', 12, 16);
      if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
      }
      if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      return undefined;
    }
    // JPEG: walk the markers to a start-of-frame
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return undefined;
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// PNG: decode (8-bit grey, grey+alpha, RGB, RGBA, palette; not interlaced),
// shrink (area average), encode (RGBA, 8-bit).
// ---------------------------------------------------------------------------

interface Rgba {
  width: number;
  height: number;
  data: Uint8Array; // RGBA, 4 bytes per pixel
}

/** Decode a PNG to RGBA, or undefined for the kinds not handled here (16-bit, interlaced, <8-bit). */
export function decodePng(buf: Buffer): Rgba | undefined {
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  let palette: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]!;
      color = data[9]!;
      interlace = data[12]!;
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  if (!channels || depth !== 8 || interlace !== 0 || !width || !height) return undefined;
  if (color === 3 && !palette) return undefined;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at]!;
    const line = raw.subarray(at + 1, at + 1 + stride);
    const out = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
    prev = out;
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    const s = i * channels;
    if (color === 6) rgba.set(rows.subarray(s, s + 4), j);
    else if (color === 2) {
      rgba[j] = rows[s]!;
      rgba[j + 1] = rows[s + 1]!;
      rgba[j + 2] = rows[s + 2]!;
      rgba[j + 3] = 255;
    } else if (color === 0 || color === 4) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = rows[s]!;
      rgba[j + 3] = color === 4 ? rows[s + 1]! : 255;
    } else {
      const k = rows[s]!;
      rgba[j] = palette![k * 3] ?? 0;
      rgba[j + 1] = palette![k * 3 + 1] ?? 0;
      rgba[j + 2] = palette![k * 3 + 2] ?? 0;
      rgba[j + 3] = trns && k < trns.length ? trns[k]! : 255;
    }
  }
  return { width, height, data: rgba };
}

/** Shrink by averaging the source pixels each target pixel covers. */
export function shrink(img: Rgba, width: number, height: number): Rgba {
  const out = new Uint8Array(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i]!;
          g += img.data[i + 1]!;
          b += img.data[i + 2]!;
          a += img.data[i + 3]!;
          n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width, height, data: out };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Buffer[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (const byte of p) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([head.subarray(4), data]), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode RGBA as an 8-bit RGBA PNG (Sub filter on every row). */
export function encodePng(img: Rgba): Buffer {
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    const o = y * (stride + 1);
    raw[o] = 1; // Sub
    const row = img.data.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (row[x]! - (x >= 4 ? row[x - 4]! : 0)) & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------

export type PreparedImage =
  | { ok: true; image: ImageInfo & { path: string; resized: boolean } }
  /** too_large: over the limits and not shrinkable here; unreadable: not an image this can read. */
  | { ok: false; code: 'image.too_large' | 'image.unreadable'; message: string };

/**
 * Check an attached image against IMAGE_LIMITS and store the copy that will be
 * sent in `dir` (named by its content): the file as it is when within the
 * limits, else a smaller PNG. The original is not touched.
 */
export function prepareImage(src: string, dir: string, limits: { maxLongSide: number; maxBytes: number } = IMAGE_LIMITS): PreparedImage {
  let buf: Buffer;
  try {
    buf = readFileSync(src);
  } catch (err) {
    return { ok: false, code: 'image.unreadable', message: err instanceof Error ? err.message : String(err) };
  }
  const mediaType = sniffImage(buf);
  const size = mediaType ? imageSize(buf, mediaType) : undefined;
  if (!mediaType || !size || !size.width || !size.height) return { ok: false, code: 'image.unreadable', message: 'not a PNG, JPEG, GIF or WEBP image that can be read' };
  const long = Math.max(size.width, size.height);
  const store = (bytes: Buffer, ext: string) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${createHash('sha256').update(bytes).digest('hex').slice(0, 20)}.${ext}`);
    writeFileSync(path, bytes);
    return path;
  };
  if (long <= limits.maxLongSide && buf.length <= limits.maxBytes) {
    mkdirSync(dir, { recursive: true });
    const ext = mediaType.split('/')[1]!.replace('jpeg', 'jpg');
    const path = join(dir, `${createHash('sha256').update(buf).digest('hex').slice(0, 20)}.${ext}`);
    copyFileSync(src, path);
    return { ok: true, image: { mediaType, ...size, bytes: statSync(path).size, path, resized: false } };
  }
  const decoded = mediaType === 'image/png' ? decodePng(buf) : undefined;
  if (!decoded) {
    return {
      ok: false,
      code: 'image.too_large',
      message: `${size.width}x${size.height}, ${buf.length} bytes: over ${limits.maxLongSide} px or ${limits.maxBytes} bytes, and only 8-bit PNG can be made smaller here`,
    };
  }
  // shrink to the long edge, then further while the file is still too big
  let scale = Math.min(1, limits.maxLongSide / long);
  for (let attempt = 0; attempt < 6; attempt++) {
    const w = Math.max(1, Math.round(size.width * scale));
    const h = Math.max(1, Math.round(size.height * scale));
    const png = encodePng(shrink(decoded, w, h));
    if (png.length <= limits.maxBytes) return { ok: true, image: { mediaType: 'image/png', width: w, height: h, bytes: png.length, path: store(png, 'png'), resized: true } };
    scale *= 0.75;
  }
  return { ok: false, code: 'image.too_large', message: 'still over the size limit after shrinking' };
}

/** The image as base64 for a request, or undefined when the stored copy is gone. */
export function imageBase64(path: string): string | undefined {
  try {
    return readFileSync(path).toString('base64');
  } catch {
    return undefined;
  }
}

/**
 * Tokens an image takes for a provider kind (for budget estimates; the context
 * use shown comes from what the provider reports). Anthropic: ceil(w/28) x
 * ceil(h/28). Others: the highest of the OpenAI patch count (ceil(w/32) x
 * ceil(h/32)) with a 1.5 factor (OpenAI's own factors go up to 1.2), the
 * Anthropic count, and Gemini's fixed 1,120 per image, so an unknown formula is
 * not underestimated.
 */
export function imageTokens(kind: string, width: number, height: number): number {
  const anthropic = Math.ceil(width / 28) * Math.ceil(height / 28);
  if (kind === 'anthropic') return anthropic;
  const openai = Math.ceil(Math.ceil(width / 32) * Math.ceil(height / 32) * 1.5);
  return Math.max(openai, anthropic, 1120);
}

/**
 * How many images one request may carry, and their total size: Anthropic asks
 * for smaller images when a request has more than 20; Gemini allows 20 MB of
 * inline data per request. Older images beyond these are left out (the newest
 * are kept), since every turn sends the conversation's images again.
 */
export const REQUEST_IMAGE_LIMITS = { maxImages: 20, maxBase64Bytes: 15_000_000 };
