// Images in a message: recognised by their bytes, made smaller when over the
// limits, sent in each provider's own format, never written into the record,
// and a model that refuses them is told apart.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_LIMITS } from '@spica/protocol';
import { createAgentApi } from './api.ts';
import { decodePng, encodePng, imageSize, imageTokens, prepareImage, sniffImage } from './images.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { anthropicProvider, captureEvents, makeRuntime, startGateway, tempDir } from './testing/helpers.ts';

// gateways, child processes and local servers start slowly when several full runs share the machine
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  gw = await startGateway();
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await gw.stop();
  await cleanup();
});

/** A PNG of a simple gradient (so it compresses but is not trivial). */
function png(width: number, height: number): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x % 256;
      data[i + 1] = y % 256;
      data[i + 2] = (x + y) % 256;
      data[i + 3] = 255;
    }
  }
  return encodePng({ width, height, data });
}
const write = (name: string, buf: Buffer) => {
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
};
/** A minimal JPEG header with a start-of-frame giving the size (enough to measure; not a picture). */
function jpegHeader(width: number, height: number, pad = 0): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0]), sof, Buffer.alloc(pad)]);
}

describe('images', () => {
  it('are told by their bytes and measured without decoding', () => {
    expect(sniffImage(png(3, 2))).toBe('image/png');
    expect(imageSize(png(3, 2), 'image/png')).toEqual({ width: 3, height: 2 });
    expect(sniffImage(jpegHeader(640, 480))).toBe('image/jpeg');
    expect(imageSize(jpegHeader(640, 480), 'image/jpeg')).toEqual({ width: 640, height: 480 });
    const gif = Buffer.from('GIF89a\x20\x03\x58\x02', 'latin1');
    expect([sniffImage(gif), imageSize(gif, 'image/gif')]).toEqual(['image/gif', { width: 800, height: 600 }]);
    expect(sniffImage(Buffer.from('%PDF-1.7 hello'))).toBeUndefined();
    // a round trip keeps the pixels
    const p = png(5, 4);
    expect(encodePng(decodePng(p)!).equals(p)).toBe(true);
  });

  it('within the limits are kept as they are; larger PNGs are made smaller; larger JPEGs and non-images are refused with a code', () => {
    const media = join(dir, 'media');
    const small = prepareImage(write('small.png', png(800, 600)), media);
    expect(small).toMatchObject({ ok: true, image: { mediaType: 'image/png', width: 800, height: 600, resized: false } });
    const big = prepareImage(write('big.png', png(3200, 1800)), media);
    expect(big).toMatchObject({ ok: true, image: { mediaType: 'image/png', width: IMAGE_LIMITS.maxLongSide, height: 882, resized: true } });
    if (big.ok) expect(decodePng(readFileSync(big.image.path))).toMatchObject({ width: 1568, height: 882 });
    expect(prepareImage(write('big.jpg', jpegHeader(4000, 3000)), media)).toMatchObject({ ok: false, code: 'image.too_large' });
    expect(prepareImage(write('notes.txt', Buffer.from('hello')), media)).toMatchObject({ ok: false, code: 'image.unreadable' });
  });

  it('count in tokens by the provider\'s rule (Anthropic: 28-px patches), never less for others', () => {
    expect(imageTokens('anthropic', 1000, 1000)).toBe(1296); // Anthropic's own worked example
    expect(imageTokens('anthropic', 1920, 1080)).toBe(2691);
    expect(imageTokens('openai-compatible', 1000, 1000)).toBe(Math.ceil(32 * 32 * 1.5)); // above Anthropic's and Gemini's 1,120
    expect(imageTokens('openai-compatible', 100, 100)).toBe(1120); // Gemini's fixed count for a small one
  });

  it('a request keeps the newest images within its limits; older ones become a line of text', async () => {
    gw.onRequest(() => ({ text: 'ok' }));
    const rt = makeRuntime(gw, { cwd: dir, mediaDir: join(dir, 'media') });
    const s = rt.createSession();
    for (let turn = 0; turn < 3; turn++) {
      const r = await s.readAttachments(Array.from({ length: 8 }, (_, i) => ({ path: write(`t${turn}-${i}.png`, png(6 + i, 6 + turn)) })));
      await s.send(`turn ${turn}`, { content: r.content, meta: { attachments: r.attachments } }).done;
    }
    const body = JSON.stringify(gw.requests.at(-1)!.body);
    expect(body.match(/"type":"image_url"/g)).toHaveLength(20); // 24 attached, the newest 20 sent
    expect(body.match(/left out of this request to keep it small/g)).toHaveLength(4);
    await rt.close();
  });
});

describe('images in a conversation', () => {
  it('go to an OpenAI-compatible model as data URLs; the record keeps only the path and size', async () => {
    gw.onRequest(() => ({ text: 'I see a gradient', usage: { input: 900, output: 5 } }));
    const rt = makeRuntime(gw, { cwd: dir, mediaDir: join(dir, 'media') });
    const api = createAgentApi(rt);
    const s = rt.createSession();
    const image = write('shot.png', png(1200, 800));
    const h = await api.send(s.id, 'What is in the screenshot?', { attachments: [{ path: image }] });
    void h;
    await s.idle();
    const body = gw.requests.at(-1)!.body as { messages: { role: string; content: unknown }[] };
    const user = body.messages.find((m) => m.role === 'user')!;
    expect(user.content).toEqual([
      { type: 'text', text: 'What is in the screenshot?' },
      { type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,iVBORw0KGgo/) } },
    ]);
    const msg = s.messages().find((m) => m.kind === 'user')!;
    expect(msg.content[1]).toMatchObject({ type: 'image', mediaType: 'image/png', width: 1200, height: 800, name: 'shot.png' });
    expect(msg.meta?.attachments?.[0]).toMatchObject({ name: 'shot.png', block: 1, image: { width: 1200, height: 800, resized: false } });
    // no pixels in the record or the usage log
    const b64 = readFileSync(image).toString('base64').slice(0, 200);
    expect(JSON.stringify(rt.store.listMessages(s.id))).not.toContain(b64);
    expect(rt.exportUsageLog()).not.toContain(b64);
    // the copy the core keeps is not the original
    const kept = (msg.content[1] as { path: string }).path;
    expect(kept.startsWith(join(dir, 'media'))).toBe(true);
    await rt.close();
  });

  it('go to an Anthropic model as base64 image blocks', async () => {
    gw.onRequest(() => ({ text: 'ok' }));
    const rt = makeRuntime(gw, { cwd: dir, mediaDir: join(dir, 'media'), providers: [anthropicProvider(gw)], defaults: { providerId: 'fake-anthropic', model: 'claude-haiku-5-5', maxTokens: 64 } });
    const api = createAgentApi(rt);
    const s = rt.createSession();
    await api.send(s.id, 'Look', { attachments: [{ path: write('a.png', png(10, 10)) }] });
    await s.idle();
    const body = gw.requests.at(-1)!.body as { messages: { role: string; content: Record<string, unknown>[] }[] };
    const user = body.messages.find((m) => m.role === 'user')!;
    expect(user.content).toContainEqual(expect.objectContaining({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: expect.stringMatching(/^iVBORw0KGgo/) } }));
    await rt.close();
  });

  it('a model that refuses images: the error says so (model.no_images), and later turns leave the images out', async () => {
    const rt = makeRuntime(gw, { cwd: dir, mediaDir: join(dir, 'media') });
    const events = captureEvents(rt);
    const api = createAgentApi(rt);
    const s = rt.createSession();
    gw.enqueue({ status: 400, errorBody: JSON.stringify({ error: { message: 'Invalid request: this model does not support image input' } }) });
    await api.send(s.id, 'Look', { attachments: [{ path: write('a.png', png(10, 10)) }] });
    await s.idle();
    expect(events.filter((e) => e.type === 'error').map((e) => (e.type === 'error' ? e.code : null))).toContain('model.no_images');
    expect(rt.imagesAllowed('fake-openai', 'fake-model')).toBe(false);
    // the conversation goes on: the image becomes a line of text
    gw.enqueue({ text: 'fine' });
    await s.send('Then just tell me hello').done;
    const body = JSON.stringify(gw.requests.at(-1)!.body);
    expect(body).not.toContain('image_url');
    expect(body).toContain('left out, this model does not take images');
    // a new image to the same model is refused up front, without a call
    const n = gw.requests.length;
    await api.send(s.id, 'And this one?', { attachments: [{ path: write('b.png', png(10, 10)) }] });
    await s.idle();
    expect(gw.requests.length).toBe(n);
    expect(events.filter((e) => e.type === 'error' && e.code === 'model.no_images')).toHaveLength(2);
    await rt.close();
  });

  it('a model the catalog lists as text only: images are refused before any call; a model that takes them is known', async () => {
    const rt = makeRuntime(gw, { cwd: dir, mediaDir: join(dir, 'media'), defaults: { providerId: 'fake-openai', model: 'deepseek-v4-pro', maxTokens: 64 } });
    rt.ledger.setCatalogIds({ 'fake-openai': 'deepseek' }); // as if set up from the DeepSeek preset
    expect([rt.imagesAllowed('fake-openai', 'deepseek-v4-pro'), rt.imagesAllowed('fake-openai', 'deepseek-flash'), rt.imagesAllowed('fake-openai', 'other')]).toEqual([false, true, undefined]);
    const events = captureEvents(rt);
    const api = createAgentApi(rt);
    const s = rt.createSession();
    await api.send(s.id, 'Look', { attachments: [{ path: write('c.png', png(10, 10)) }] });
    await s.idle();
    expect(gw.requests).toHaveLength(0);
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'model.no_images' });
    await rt.close();
  });

  it('more images than a message may carry: the extra ones are named with a code', async () => {
    const rt = makeRuntime(gw, { cwd: dir, mediaDir: join(dir, 'media') });
    const s = rt.createSession();
    const many = Array.from({ length: IMAGE_LIMITS.maxPerMessage + 1 }, (_, i) => ({ path: write(`p${i}.png`, png(4 + i, 4)) }));
    const r = await s.readAttachments(many);
    expect(r.content.filter((b) => b.type === 'image')).toHaveLength(IMAGE_LIMITS.maxPerMessage);
    expect(r.attachments.at(-1)).toMatchObject({ code: 'image.too_many', block: null });
    await rt.close();
  });

  it('the kept copies go when the conversation is deleted (with its project)', async () => {
    const rt = makeRuntime(gw, { cwd: dir, mediaDir: join(dir, 'media'), projectsRoot: join(dir, 'projects') });
    const p = rt.createProject({ name: 'Pics' });
    const manager = rt.session(p.managerSessionId)!;
    const r = await manager.readAttachments([{ path: write('m.png', png(6, 6)) }]);
    const kept = (r.content[0] as { path: string }).path;
    expect(existsSync(kept)).toBe(true);
    await rt.deleteProject(p.id);
    expect(existsSync(kept)).toBe(false);
    expect(existsSync(rt.mediaDir(manager.id))).toBe(false);
    await rt.close();
  });
});
