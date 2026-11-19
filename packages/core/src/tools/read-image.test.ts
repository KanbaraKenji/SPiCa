import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeBmp, decodePng, encodePng, encodePngCompact } from '../images.ts';
import { MemoryStore } from '../store/memory.ts';
import { tempDir } from '../testing/helpers.ts';
import { Tracer } from '../trace.ts';
import type { CoreEventBody } from '../types.ts';
import { readFileTool } from './fs-tools.ts';
import { producedFileCard } from './file-card.ts';
import { keepOriginal, PAGE_PICTURE_BYTES, pagePictures } from './read-image.ts';
import type { ToolContext } from './types.ts';

let dir: string;
let cleanup: () => Promise<void>;
let ctx: ToolContext;
let events: CoreEventBody[];

function png(width: number, height: number, grey = true): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = i % 251;
    data[i * 4 + 1] = grey ? i % 251 : 30;
    data[i * 4 + 2] = grey ? i % 251 : 60;
    data[i * 4 + 3] = 255;
  }
  return encodePng({ width, height, data });
}

/** A JPEG header saying width x height (enough for the size checks; never decoded here). */
function jpegHeader(width: number, height: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(64)]);
}

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  events = [];
  ctx = {
    sessionId: 's',
    parentChain: [],
    cwd: dir,
    signal: new AbortController().signal,
    tracer: new Tracer(new MemoryStore()),
    extractors: [],
    services: {},
    callId: 'c',
    mediaDir: join(dir, 'media'),
    providerKind: 'anthropic',
    emit: (e) => events.push(e),
  };
});
afterEach(async () => {
  await cleanup();
});

describe('read_file on a picture', () => {
  it('hands the picture to the model as an image, with a card', async () => {
    await writeFile(join(dir, 'chart.png'), png(280, 140));
    const r = await readFileTool.execute({ path: 'chart.png' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('The picture follows as an image: 280x140 px, about 50 tokens.');
    expect(r.images).toHaveLength(1);
    expect(r.images![0]).toMatchObject({ type: 'image', mediaType: 'image/png', width: 280, height: 140, name: 'chart.png' });
    expect(r.images![0]!.path.startsWith(join(dir, 'media'))).toBe(true);
    expect(events.find((e) => e.type === 'file.card')).toMatchObject({ file: { name: 'chart.png', kind: 'other', image: { width: 280, height: 140 } } });
    expect(r.content).toContain('(picture, 280x140 px, ');
  });

  it('makes a large PNG smaller itself', async () => {
    await writeFile(join(dir, 'big.png'), png(3136, 1000));
    const r = await readFileTool.execute({ path: 'big.png' }, ctx);
    expect(r.content).toContain('a smaller copy, 1568x500 px');
    expect(decodePng(readFileSync(r.images![0]!.path))).toMatchObject({ width: 1568, height: 500 });
  });

  it('asks the host to shrink a large JPEG, and says why when there is no host', async () => {
    await writeFile(join(dir, 'photo.jpg'), jpegHeader(4000, 3000));
    const alone = await readFileTool.execute({ path: 'photo.jpg' }, ctx);
    expect(alone.isError).toBe(true);
    expect(alone.content).toContain('The picture cannot be sent');
    const asked: string[] = [];
    ctx.fitImage = async (src, out) => {
      asked.push(src);
      const p = join(out, 'fitted.png');
      await writeFile(p, png(1568, 1176));
      return p;
    };
    const r = await readFileTool.execute({ path: 'photo.jpg' }, ctx);
    expect(asked).toEqual([join(dir, 'photo.jpg')]);
    expect(r.images![0]).toMatchObject({ width: 1568, height: 1176 });
    expect(r.content).toContain('a smaller copy, 1568x1176 px');
  });

  it('decodes a BMP itself and sends it as a PNG, shrunk when over the limits', async () => {
    // 24-bit, bottom-up, 2000 x 1000: left half red, right half blue
    const w = 2000;
    const h = 1000;
    const stride = Math.ceil((w * 3) / 4) * 4;
    const bmp = Buffer.alloc(54 + stride * h);
    bmp.write('BM', 0, 'latin1');
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(w, 18);
    bmp.writeInt32LE(h, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bmp[54 + y * stride + x * 3 + (x < w / 2 ? 2 : 0)] = 255;
    await writeFile(join(dir, 'scan.bmp'), bmp);
    const r = await readFileTool.execute({ path: 'scan.bmp' }, ctx);
    expect(r.content).toContain('a smaller copy, 1568x784 px');
    const png = decodePng(readFileSync(r.images![0]!.path))!;
    expect([...png.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...png.data.subarray((png.width - 1) * 4, png.width * 4)]).toEqual([0, 0, 255, 255]);
  });

  it('reads an 8-bit palette BMP stored top-down', () => {
    const w = 3;
    const h = 2;
    const stride = 4;
    const bmp = Buffer.alloc(54 + 2 * 4 + stride * h);
    bmp.write('BM', 0, 'latin1');
    bmp.writeUInt32LE(54 + 8, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(w, 18);
    bmp.writeInt32LE(-h, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(8, 28);
    bmp.writeUInt32LE(2, 46); // two colours: black, green
    bmp.set([0, 0, 0, 0, 0, 200, 0, 0], 54);
    bmp.set([1, 0, 1], 62); // first row: green black green
    const img = decodeBmp(bmp)!;
    expect([img.width, img.height]).toEqual([3, 2]);
    expect([...img.data.subarray(0, 8)]).toEqual([0, 200, 0, 255, 0, 0, 0, 255]);
    expect(decodeBmp(Buffer.from('BM not really a bitmap at all, only some text here for the test'))).toBeUndefined();
  });

  it('says so in a sentence when the model does not take images', async () => {
    await writeFile(join(dir, 'chart.png'), png(28, 28));
    ctx.imagesAllowed = false;
    const r = await readFileTool.execute({ path: 'chart.png' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.images).toBeUndefined();
    expect(r.content).toContain('The current model does not take images');
  });
});

describe('read_file with a region', () => {
  /** 4000 x 2000, each pixel's red and green say where it is (x / 16, y / 8), so a cut part can be checked. */
  function marked(): Buffer {
    const w = 4000;
    const h = 2000;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        data[o] = Math.floor(x / 16);
        data[o + 1] = Math.floor(y / 8);
        data[o + 3] = 255;
      }
    }
    return encodePng({ width: w, height: h, data });
  }

  it('says how to look closer when a picture went smaller, and sends the part at full detail', async () => {
    await writeFile(join(dir, 'sheet.png'), marked());
    const whole = await readFileTool.execute({ path: 'sheet.png' }, ctx);
    expect(whole.content).toContain('a smaller copy, 1568x784 px');
    expect(whole.content).toContain('Small text may not be legible at this size. Call read_file again with region="left,top,right,bottom"');
    expect(whole.content).toContain('up to 2.6x this detail');

    const part = await readFileTool.execute({ path: 'sheet.png', region: '50,25,75,50' }, ctx);
    expect(part.isError).toBeFalsy();
    expect(part.content).toContain('The part (pixels 2000-3000 across and 500-1000 down) follows as an image: 1000x500 px, the picture\'s full detail');
    expect(part.images![0]).toMatchObject({ width: 1000, height: 500, name: 'sheet.png part' });
    const img = decodePng(readFileSync(part.images![0]!.path))!;
    // top left pixel of the part is pixel (2000, 500) of the picture
    expect([img.data[0], img.data[1]]).toEqual([Math.floor(2000 / 16), Math.floor(500 / 8)]);
    expect(events.filter((e) => e.type === 'file.card').at(-1)).toMatchObject({ file: { image: { width: 4000, height: 2000 } } });
  });

  it('shrinks a part still over the limits and says how much detail it keeps', async () => {
    await writeFile(join(dir, 'sheet.png'), marked());
    const r = await readFileTool.execute({ path: 'sheet.png', region: '0,0,100,50' }, ctx);
    expect(r.content).toContain('1568x392 px, 39% of the picture\'s full detail; a smaller region shows more');
  });

  it('refuses a region it cannot read, and a region on a file that is no picture or PDF', async () => {
    await writeFile(join(dir, 'sheet.png'), png(40, 20));
    await writeFile(join(dir, 'notes.txt'), 'x');
    expect((await readFileTool.execute({ path: 'sheet.png', region: 'top half' }, ctx)).content).toContain('region must be "left,top,right,bottom" in percent');
    expect((await readFileTool.execute({ path: 'sheet.png', region: '60,0,40,100' }, ctx)).content).toContain('right must be more than left');
    // a picture that went whole at its own size: a part adds nothing, and the model is told so
    const small = await readFileTool.execute({ path: 'sheet.png', region: '0,0,50,50' }, ctx);
    expect(small.content).toContain('a part of it shows nothing more.');
    const txt = await readFileTool.execute({ path: 'notes.txt', region: '0,0,50,50' }, ctx);
    expect(txt).toMatchObject({ isError: true, content: 'region is for pictures and PDF pages.' });
  });

  it('asks the host to cut a part of a JPEG, in the picture\'s pixels', async () => {
    await writeFile(join(dir, 'photo.jpg'), jpegHeader(4000, 3000));
    const asked: unknown[] = [];
    ctx.fitImage = async (_src, out, crop) => {
      asked.push(crop);
      const p = join(out, 'part.png');
      await writeFile(p, png(1000, 750));
      return p;
    };
    const r = await readFileTool.execute({ path: 'photo.jpg', region: '25,25,50,50' }, ctx);
    expect(asked).toEqual([{ x: 1000, y: 750, width: 1000, height: 750 }]);
    expect(r.content).toContain('1000x750 px, the picture\'s full detail');
  });

  it('says the one sentence when the model does not take images', async () => {
    await writeFile(join(dir, 'sheet.png'), png(40, 20));
    ctx.imagesAllowed = false;
    const r = await readFileTool.execute({ path: 'sheet.png', region: '0,0,50,50' }, ctx);
    expect(r.images).toBeUndefined();
    expect(r.content).toContain('The current model does not take images');
  });

  it('keeps an attached picture that went smaller, and names it for a closer look', async () => {
    await writeFile(join(dir, 'paste.png'), png(3136, 1000));
    const said = await keepOriginal(join(dir, 'paste.png'), { width: 1568, height: 500 }, join(dir, 'media'));
    const kept = /path="([^"]+)"/.exec(said!)![1]!;
    expect(kept.endsWith('paste.png')).toBe(true);
    expect(readFileSync(kept).equals(readFileSync(join(dir, 'paste.png')))).toBe(true);
    expect(said).toContain('[The picture is 3136x1000 px; the copy above is 1568x500 px.');
    expect(await keepOriginal(join(dir, 'paste.png'), { width: 3136, height: 1000 }, join(dir, 'media'))).toBeUndefined();
  });
});

describe('read_file on scanned PDF pages', () => {
  it('asks the reader for page pictures and sends them after the text, with their token count', async () => {
    const seen: unknown[] = [];
    ctx.extractors.push({
      extensions: ['.pdf'],
      extract: async (path, req) => {
        seen.push(req.pageImages);
        const rgba = new Uint8Array(56 * 28 * 4).fill(200);
        return {
          text: 'PDF, 2 pages.\nPages 1-2 follow as pictures.',
          meta: { path, name: 'scan.pdf', kind: 'pdf', sizeBytes: 1, modifiedAt: '', extractedAt: '', read: { pages: '1-2' } },
          pageImages: [
            { page: 1, width: 56, height: 28, rgba },
            { page: 2, width: 56, height: 28, rgba },
          ],
        };
      },
    });
    await writeFile(join(dir, 'scan.pdf'), '%PDF');
    const r = await readFileTool.execute({ path: 'scan.pdf' }, ctx);
    expect(seen).toEqual([10]);
    expect(r.images?.map((i) => i.name)).toEqual(['scan.pdf page 1', 'scan.pdf page 2']);
    expect(r.content).toContain('[2 page pictures follow as images (pages 1, 2), about 4 tokens in all.]');
    expect(r.content).toContain('Call read_file with pages="1" and region="left,top,right,bottom"');
    ctx.imagesAllowed = false;
    await readFileTool.execute({ path: 'scan.pdf' }, ctx);
    expect(seen.at(-1)).toBe(0);
  });
});

describe('cards for files a call made', () => {
  it('say a picture with its size, and an old Excel or Word file as Excel or Word', async () => {
    await writeFile(join(dir, 'photo.jpg'), jpegHeader(4000, 3000));
    const bmp = Buffer.alloc(64);
    bmp.write('BM', 0, 'latin1');
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(1400, 18);
    bmp.writeInt32LE(-2600, 22);
    await writeFile(join(dir, 'scan.bmp'), bmp);
    await writeFile(join(dir, 'old.xls'), 'x');
    await writeFile(join(dir, 'old.doc'), 'x');
    expect(await producedFileCard(join(dir, 'photo.jpg'), 'created')).toMatchObject({ kind: 'other', image: { width: 4000, height: 3000 } });
    expect(await producedFileCard(join(dir, 'scan.bmp'), 'created')).toMatchObject({ image: { width: 1400, height: 2600 } });
    expect((await producedFileCard(join(dir, 'old.xls'), 'created'))?.kind).toBe('xlsx');
    expect((await producedFileCard(join(dir, 'old.doc'), 'created'))?.kind).toBe('docx');
    expect(await producedFileCard(join(dir, 'old.doc'), 'created')).not.toHaveProperty('image');
  });
});

describe('pagePictures', () => {
  it('holds back the pages past the size a request can carry, and names them for the next read', async () => {
    const noisy = () => {
      const rgba = new Uint8Array(200 * 200 * 4);
      for (let i = 0; i < rgba.length; i++) rgba[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
      return rgba;
    };
    const pages = [1, 2, 3].map((page) => ({ page, width: 200, height: 200, rgba: noisy() }));
    // room for one noisy 200 x 200 RGB page (about 120 KB), not two
    const r = await pagePictures(pages, 'scan.pdf', ctx, 150_000);
    expect(r.images.map((i) => i.name)).toEqual(['scan.pdf page 1']);
    expect(r.note).toContain('[Pages 2, 3 were drawn but not sent, to keep the request within its size limit. Call read_file again with pages="2,3" to see them.]');
    expect(PAGE_PICTURE_BYTES).toBe(8_437_500);
  });
});

describe('encodePngCompact', () => {
  it('writes an opaque grey picture as greyscale, colour as RGB, and both decode back', async () => {
    const grey = decodePng(png(40, 20, true))!;
    const g = await encodePngCompact(grey);
    expect(g[25]).toBe(0); // colour type: grey
    expect(decodePng(g)).toEqual(grey);
    const colour = decodePng(png(40, 20, false))!;
    const c = await encodePngCompact(colour);
    expect(c[25]).toBe(2); // RGB
    expect(decodePng(c)).toEqual(colour);
  });
});
