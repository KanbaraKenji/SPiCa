// Pictures attached to a message: pasted screenshots, dropped or picked images.
// A pasted screenshot arrives as bytes from the input box at the moment of the
// paste (the clipboard is never read here); it is saved as a PNG. A dropped or
// picked picture larger than the core's IMAGE_LIMITS is saved smaller (PNG stays
// PNG, others become JPEG 85) so it is never refused; the core keeps its own copy
// once the message is sent, so these files are only needed until then.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { IMAGE_LIMITS } from '@spica/protocol';

/** The parts of Electron's NativeImage this uses (tests pass a fake). */
export interface Picture {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(o: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): Picture;
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
}

export interface PictureIo {
  fromBuffer(data: Buffer): Picture;
  fromPath(path: string): Picture;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.has(extname(path).toLowerCase());
}

/** Within the limits: the encoded bytes, made smaller step by step if needed. */
export function fitPicture(pic: Picture, png: boolean, limits: { maxLongSide: number; maxBytes: number } = IMAGE_LIMITS): Buffer {
  const { width, height } = pic.getSize();
  let scale = Math.min(1, limits.maxLongSide / Math.max(width, height, 1));
  for (let i = 0; i < 8; i++) {
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const img = scale < 1 ? pic.resize({ width: w, height: h, quality: 'best' }) : pic;
    const out = png ? img.toPNG() : img.toJPEG(85);
    if (out.length <= limits.maxBytes) return out;
    scale *= 0.8;
  }
  const last = pic.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' });
  return png ? last.toPNG() : last.toJPEG(85);
}

export class AttachImages {
  readonly #dir: string;
  readonly #io: PictureIo;

  constructor(dir: string, io: PictureIo) {
    this.#dir = dir;
    this.#io = io;
  }

  #write(data: Buffer, ext: string): string {
    mkdirSync(this.#dir, { recursive: true });
    const path = join(this.#dir, `${randomUUID()}${ext}`);
    writeFileSync(path, data);
    return path;
  }

  /** A pasted picture as a PNG file within the limits; null when the bytes are not a picture. */
  fromPaste(data: Buffer): string | null {
    const pic = this.#io.fromBuffer(data);
    if (pic.isEmpty()) return null;
    return this.#write(fitPicture(pic, true), '.png');
  }

  /**
   * A dropped or picked file: a picture over the limits comes back as a smaller
   * copy; a picture within them, or one Chromium cannot read, as it is (the core
   * says what it thinks of it); null for anything that is not a picture.
   */
  prepare(path: string): string | null {
    if (!isImagePath(path)) return null;
    const pic = this.#io.fromPath(path);
    if (pic.isEmpty()) return path;
    const { width, height } = pic.getSize();
    let bytes: number;
    try {
      bytes = statSync(path).size;
    } catch {
      return path;
    }
    if (Math.max(width, height) <= IMAGE_LIMITS.maxLongSide && bytes <= IMAGE_LIMITS.maxBytes) return path;
    const png = extname(path).toLowerCase() === '.png';
    return this.#write(fitPicture(pic, png), png ? '.png' : '.jpg');
  }

  /** Files left from earlier runs (older than a day) are removed at start. */
  sweep(now = Date.now()): void {
    let names: string[];
    try {
      names = readdirSync(this.#dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(this.#dir, n);
      try {
        if (now - statSync(p).mtimeMs > 24 * 60 * 60 * 1000) rmSync(p, { force: true });
      } catch {
        // gone already
      }
    }
  }
}
