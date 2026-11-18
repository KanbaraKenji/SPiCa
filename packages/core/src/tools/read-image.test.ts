import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodePng, encodePng, encodePngCompact } from '../images.ts';
import { MemoryStore } from '../store/memory.ts';
import { tempDir } from '../testing/helpers.ts';
import { Tracer } from '../trace.ts';
import type { CoreEventBody } from '../types.ts';
import { readFileTool } from './fs-tools.ts';
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
    expect(events.find((e) => e.type === 'file.card')).toMatchObject({ file: { name: 'chart.png', kind: 'other' } });
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

  it('says so in a sentence when the model does not take images', async () => {
    await writeFile(join(dir, 'chart.png'), png(28, 28));
    ctx.imagesAllowed = false;
    const r = await readFileTool.execute({ path: 'chart.png' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.images).toBeUndefined();
    expect(r.content).toContain('The current model does not take images');
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
    ctx.imagesAllowed = false;
    await readFileTool.execute({ path: 'scan.pdf' }, ctx);
    expect(seen.at(-1)).toBe(0);
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
