import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachImages, fitPicture, isImagePath, type Picture } from './images';

// A picture whose encoded size follows its pixel count (bytesPerPixel), like a photo.
function fake(width: number, height: number, bytesPerPixel = 1): Picture & { resizedTo: string[] } {
  const resizedTo: string[] = [];
  const make = (w: number, h: number): Picture => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: (o) => {
      resizedTo.push(`${o.width}x${o.height}`);
      return make(o.width, o.height);
    },
    toPNG: () => Buffer.alloc(w * h * bytesPerPixel),
    toJPEG: () => Buffer.alloc(Math.round(w * h * bytesPerPixel * 0.3)),
  });
  return Object.assign(make(width, height), { resizedTo });
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('pictures for a message', () => {
  it('a picture within the limits is kept as it is', () => {
    const p = fake(800, 600);
    expect(fitPicture(p, true, { maxLongSide: 1568, maxBytes: 1_000_000 }).length).toBe(480_000);
    expect(p.resizedTo).toEqual([]);
  });

  it('the long side comes down to the limit, then the size until the bytes fit', () => {
    const p = fake(3136, 1000, 1);
    const out = fitPicture(p, true, { maxLongSide: 1568, maxBytes: 300_000 });
    expect(p.resizedTo[0]).toBe('1568x500');
    expect(out.length).toBeLessThanOrEqual(300_000);
  });

  it('knows pictures by extension', () => {
    expect(isImagePath('C:/a/截图.PNG')).toBe(true);
    expect(isImagePath('C:/a/b.jpeg')).toBe(true);
    expect(isImagePath('C:/a/报告.pdf')).toBe(false);
  });

  it('a pasted picture is saved as a PNG file; bytes that are no picture give nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attach-'));
    dirs.push(dir);
    const ok = new AttachImages(dir, { fromBuffer: () => fake(10, 10), fromPath: () => fake(10, 10) });
    const path = ok.fromPaste(Buffer.from('x'));
    expect(path?.endsWith('.png')).toBe(true);
    expect(statSync(path!).size).toBe(100);
    const none = new AttachImages(dir, { fromBuffer: () => ({ ...fake(1, 1), isEmpty: () => true }), fromPath: () => fake(1, 1) });
    expect(none.fromPaste(Buffer.from('x'))).toBeNull();
  });

  it('a dropped picture over the limits is replaced by a smaller copy; others stay; non-pictures are not touched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attach-'));
    dirs.push(dir);
    const big = join(dir, 'photo.jpg');
    const small = join(dir, 'icon.png');
    writeFileSync(big, Buffer.alloc(10));
    writeFileSync(small, Buffer.alloc(10));
    const imgs = new AttachImages(join(dir, 'out'), { fromBuffer: () => fake(1, 1), fromPath: (p) => (p === big ? fake(4000, 3000) : fake(100, 100)) });
    const copy = imgs.prepare(big);
    expect(copy).not.toBe(big);
    expect(copy?.endsWith('.jpg')).toBe(true);
    expect(imgs.prepare(small)).toBe(small);
    expect(imgs.prepare(join(dir, 'notes.txt'))).toBeNull();
  });
});
