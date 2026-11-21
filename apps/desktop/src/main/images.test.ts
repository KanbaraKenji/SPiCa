import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachImages, fitForModel, fitPicture, headerSize, isImagePath, type Picture } from './images';

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
    crop: (r) => {
      resizedTo.push(`crop ${r.x},${r.y} ${r.width}x${r.height}`);
      return make(r.width, r.height);
    },
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

  it('a pasted picture is saved as a PNG file named by the time, at its own size; bytes that are no picture give nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attach-'));
    dirs.push(dir);
    const big = fake(4000, 3000);
    const ok = new AttachImages(dir, { fromBuffer: () => big, fromPath: () => fake(10, 10) });
    const path = ok.fromPaste(Buffer.from('x'), new Date(2026, 10, 19, 8, 5, 3));
    expect(basename(path!)).toBe('2026-11-19 08-05-03.png');
    expect(statSync(path!).size).toBe(4000 * 3000);
    expect(big.resizedTo).toEqual([]);
    // the folders left from earlier runs go at start
    ok.sweep(Date.now() + 2 * 24 * 60 * 60 * 1000);
    expect(existsSync(path!)).toBe(false);
    const none = new AttachImages(dir, { fromBuffer: () => ({ ...fake(1, 1), isEmpty: () => true }), fromPath: () => fake(1, 1) });
    expect(none.fromPaste(Buffer.from('x'))).toBeNull();
  });

  it('a dropped picture is passed on as it is, however large; non-pictures give nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attach-'));
    dirs.push(dir);
    const big = join(dir, 'photo.jpg');
    writeFileSync(big, Buffer.alloc(10));
    const imgs = new AttachImages(join(dir, 'out'), { fromBuffer: () => fake(1, 1), fromPath: () => fake(4000, 3000) });
    expect(imgs.prepare(big)).toBe(big);
    expect(imgs.prepare(join(dir, 'notes.txt'))).toBeNull();
  });
});

describe('pictures read_file shows the model', () => {
  it('writes a copy within the limits in the given folder: PNG for lossless sources, JPEG for photos', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-fit-'));
    dirs.push(dir);
    const io = { fromBuffer: () => fake(1, 1), fromPath: () => fake(4000, 3000, 0.1) };
    const jpg = await fitForModel(io, join(dir, 'photo.JPG'), join(dir, 'media'));
    expect(jpg).toMatch(/[\\/]media[\\/]fit-[0-9a-f]{20}\.jpg$/);
    expect(statSync(jpg!).size).toBeGreaterThan(0);
    expect(await fitForModel(io, join(dir, 'notes.txt'), join(dir, 'media'))).toBeNull();
  });

  it("reads what Chromium cannot (BMP, GIF, WEBP) through the system's picture, never larger than the original", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-fit-'));
    dirs.push(dir);
    const bmp = Buffer.alloc(64);
    bmp.write('BM', 0, 'latin1');
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(3000, 18);
    bmp.writeInt32LE(-2000, 22); // top-down
    writeFileSync(join(dir, 'scan.bmp'), bmp);
    const gif = Buffer.from('474946383961' + '2c01' + 'c800', 'hex'); // 300 x 200
    writeFileSync(join(dir, 'small.gif'), Buffer.concat([gif, Buffer.alloc(32)]));
    const asked: string[] = [];
    const empty = { ...fake(1, 1), isEmpty: () => true };
    const io = {
      fromBuffer: () => empty,
      fromPath: () => empty,
      thumbnail: async (p: string, s: { width: number; height: number }) => {
        asked.push(`${basename(p)} ${s.width}x${s.height}`);
        return fake(s.width, s.height);
      },
    };
    expect(await fitForModel(io, join(dir, 'scan.bmp'), join(dir, 'media'))).toMatch(/\.png$/);
    expect(await fitForModel(io, join(dir, 'small.gif'), join(dir, 'media'))).toMatch(/\.png$/);
    expect(asked).toEqual(['scan.bmp 1568x1568', 'small.gif 300x300']);
    expect(await fitForModel({ fromBuffer: () => empty, fromPath: () => empty }, join(dir, 'scan.bmp'), join(dir, 'media'))).toBeNull();
    expect(headerSize(Buffer.from('not a picture at all, just some text here'))).toBeUndefined();
  });

  it("cuts a part, in the original's pixels, also from a system picture that came out smaller", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-fit-'));
    dirs.push(dir);
    const photo = fake(4000, 3000, 0.1);
    const jpg = await fitForModel({ fromBuffer: () => fake(1, 1), fromPath: () => photo }, join(dir, 'photo.jpg'), join(dir, 'media'), { x: 1000, y: 750, width: 1000, height: 750 });
    expect(jpg).toMatch(/[\\/]media[\\/]part-[0-9a-f]{20}\.jpg$/);
    expect(photo.resizedTo).toEqual(['crop 1000,750 1000x750']);

    const gif = Buffer.from('474946383961' + 'b80b' + 'd007', 'hex'); // 3000 x 2000
    writeFileSync(join(dir, 'plan.gif'), Buffer.concat([gif, Buffer.alloc(32)]));
    const empty = { ...fake(1, 1), isEmpty: () => true };
    const half = fake(1500, 1000);
    const boxes: string[] = [];
    const io = {
      fromBuffer: () => empty,
      fromPath: () => empty,
      thumbnail: async (_p: string, s: { width: number; height: number }) => {
        boxes.push(`${s.width}x${s.height}`);
        return half;
      },
    };
    expect(await fitForModel(io, join(dir, 'plan.gif'), join(dir, 'media'), { x: 300, y: 200, width: 600, height: 400 })).toMatch(/part-.*\.png$/);
    // asked at the original's size; the system gave half: the part is cut at half too
    expect(boxes).toEqual(['3000x3000']);
    expect(half.resizedTo).toEqual(['crop 150,100 300x200']);
  });
});
