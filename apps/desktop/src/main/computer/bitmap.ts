// Screen pictures for 操作电脑, as plain pixels: greying out what was not allowed, making the picture the size the
// model takes, cutting out a part (computer_zoom) and writing a PNG. No Electron here, so tests run it on made-up
// pictures; the real screen only ever comes from the real driver (driver-win32.ts).
import { deflateSync } from 'node:zlib';

/** Pixels top row first, 4 bytes each in B, G, R, A order (what Windows and Electron's bitmaps use). */
export interface Bitmap {
  width: number;
  height: number;
  data: Buffer;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The grey of what the model may not see (a mid grey, the same in both themes). */
export const MASK_GREY = 0x80;

/** A rectangle cut to the picture (empty when outside it). */
export function clip(r: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.width));
  const y1 = Math.min(height, Math.ceil(r.y + r.height));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/**
 * The picture the model gets (截图范围 E1): the whole screen, with every part where a program it may not see is on
 * top painted grey. `windows` top first, each with whether it may be seen; whatever no window covers (nothing on a
 * real screen: the desktop is Explorer's window) is grey too. Windows are painted from the bottom up, so the part
 * of an allowed window under a window that is not allowed is grey, and the other way round.
 */
export function maskScreen(src: Bitmap, windows: readonly { rect: Rect; visible: boolean }[]): Bitmap {
  const out = Buffer.alloc(src.data.length, MASK_GREY);
  for (let i = 3; i < out.length; i += 4) out[i] = 0xff;
  for (let w = windows.length - 1; w >= 0; w--) {
    const win = windows[w]!;
    const r = clip(win.rect, src.width, src.height);
    if (!r.width || !r.height) continue;
    for (let y = r.y; y < r.y + r.height; y++) {
      const start = (y * src.width + r.x) * 4;
      const end = start + r.width * 4;
      if (win.visible) src.data.copy(out, start, start, end);
      else {
        out.fill(MASK_GREY, start, end);
        for (let i = start + 3; i < end; i += 4) out[i] = 0xff;
      }
    }
  }
  return { width: src.width, height: src.height, data: out };
}

/** Paints parts grey (Spica's own windows and the bar, in case the system put them in the picture after all). */
export function greyOut(src: Bitmap, rects: readonly Rect[]): Bitmap {
  return maskScreen(src, [...rects.map((rect) => ({ rect, visible: false })), { rect: { x: 0, y: 0, width: src.width, height: src.height }, visible: true }]);
}

/** A part of the picture. */
export function crop(src: Bitmap, r: Rect): Bitmap {
  const c = clip(r, src.width, src.height);
  const out = Buffer.alloc(c.width * c.height * 4);
  for (let y = 0; y < c.height; y++) src.data.copy(out, y * c.width * 4, ((c.y + y) * src.width + c.x) * 4, ((c.y + y) * src.width + c.x + c.width) * 4);
  return { width: c.width, height: c.height, data: out };
}

/** The picture at another size: each new pixel the average of the pixels it covers (smaller), or the nearest (larger). */
export function resize(src: Bitmap, width: number, height: number): Bitmap {
  if (width === src.width && height === src.height) return src;
  const out = Buffer.alloc(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)));
      let b = 0;
      let g = 0;
      let r = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          b += src.data[i]!;
          g += src.data[i + 1]!;
          r += src.data[i + 2]!;
          n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = Math.round(b / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(r / n);
      out[o + 3] = 0xff;
    }
  }
  return { width, height, data: out };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}

/** A PNG of the picture (RGB, no transparency). */
export function encodePng(src: Bitmap): Buffer {
  const row = src.width * 3 + 1;
  const raw = Buffer.alloc(row * src.height);
  for (let y = 0; y < src.height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      const o = y * row + 1 + x * 3;
      raw[o] = src.data[i + 2]!;
      raw[o + 1] = src.data[i + 1]!;
      raw[o + 2] = src.data[i]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(src.width, 0);
  ihdr.writeUInt32BE(src.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * The size the model gets a screen picture at (Claude's computer-use rule): at most 1568 pixels on the longer
 * side and about 1.15 million pixels in all, never larger than the screen. `scale`: model pixels per screen pixel.
 */
export function fitForModel(width: number, height: number): { width: number; height: number; scale: number } {
  const scale = Math.min(1, 1568 / Math.max(width, height), Math.sqrt(1_150_000 / (width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}
