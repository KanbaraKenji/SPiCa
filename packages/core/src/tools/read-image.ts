// read_file on a picture, and the PDF pages a document reader drew as pictures (scanned pages): the copy that goes to
// the model, made with the same checks and shrinking as an attached image (images.ts; the host shrinks what the core
// cannot, Runtime.imageFitter), or a sentence saying why it cannot go.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { isoNow } from '../events.ts';
import { cropRgba, decodeBmp, decodePng, encodePngCompact, IMAGE_LIMITS, imageTokens, prepareDecoded, prepareImage, REQUEST_IMAGE_LIMITS, sniffImage, type PreparedImage } from '../images.ts';
import type { FileCardMeta, ImageBlock } from '../types.ts';
import { PICTURE_EXTENSIONS, pictureSize } from './file-card.ts';
import type { PageImage, PixelRect, ToolContext, ToolOutput } from './types.ts';

/** Files read_file hands to the model as pictures (the ones whose card says picture). */
export { PICTURE_EXTENSIONS };

/** The sentence for a model that does not take images. */
export const NO_IMAGES = 'The current model does not take images, so it cannot be shown; a model that takes images can look at it.';

function mediaDir(ctx: Pick<ToolContext, 'mediaDir' | 'sessionId'>): string {
  return ctx.mediaDir ?? join(tmpdir(), 'spica-media', ctx.sessionId.replace(/[^A-Za-z0-9_-]/g, '_'));
}

/** The picture at `src` within the limits: by the core's own checks, else the host's smaller copy. */
export async function fit(src: string, ctx: Pick<ToolContext, 'mediaDir' | 'sessionId' | 'fitImage'>): Promise<PreparedImage> {
  const dir = mediaDir(ctx);
  const own = prepareImage(src, dir);
  if (own.ok || !ctx.fitImage) return own;
  mkdirSync(dir, { recursive: true });
  const copy = await ctx.fitImage(src, dir).catch(() => undefined);
  if (!copy) return own;
  const again = prepareImage(copy, dir);
  if (again.ok && again.image.path !== copy) rmSync(copy, { force: true });
  // the host's copy is smaller than the file (or another kind): say so
  return again.ok ? { ok: true, image: { ...again.image, resized: true } } : own;
}

function block(p: Extract<PreparedImage, { ok: true }>['image'], name: string): ImageBlock {
  return { type: 'image', path: p.path, mediaType: p.mediaType, width: p.width, height: p.height, bytes: p.bytes, name };
}

function kb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A part of a picture or page, as fractions of its width and height (0-1, from the top left). */
export interface Region {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** read_file's region: "left,top,right,bottom" in percent of the width and height; a sentence when it is not one. */
export function parseRegion(text: string): Region | string {
  const nums = text.split(',').map((t) => t.trim());
  const v = nums.map(Number);
  if (nums.length !== 4 || nums.some((t) => t === '') || v.some((n) => !Number.isFinite(n))) {
    return `region must be "left,top,right,bottom" in percent of the width and height, e.g. "50,0,100,50" for the top right quarter; got "${text}"`;
  }
  const [left, top, right, bottom] = v.map((n) => Math.min(100, Math.max(0, n)) / 100) as [number, number, number, number];
  if (right <= left || bottom <= top) return `region "${text}": right must be more than left and bottom more than top`;
  return { left, top, right, bottom };
}

/** The region in whole pixels of a width x height picture (at least one pixel each way). */
export function regionPixels(r: Region, width: number, height: number): PixelRect {
  const x = Math.min(width - 1, Math.floor(r.left * width));
  const y = Math.min(height - 1, Math.floor(r.top * height));
  return { x, y, width: Math.max(1, Math.min(width, Math.ceil(r.right * width)) - x), height: Math.max(1, Math.min(height, Math.ceil(r.bottom * height)) - y) };
}

/** What a model is told when a picture went as a smaller copy: how to look at a part in more detail. */
function zoomHint(longSide: number, sentLong: number, how: string): string {
  const times = longSide / sentLong;
  return `Small text may not be legible at this size. ${how} region="left,top,right,bottom" (percent of the width and height, e.g. "0,0,50,50" for the top left quarter) to see a part at up to ${times.toFixed(1)}x this detail.`;
}

/** The part `rect` of the picture at `src`: cut here from a PNG or BMP, else by the host. */
async function fitPart(src: string, rect: PixelRect, ctx: ToolContext): Promise<PreparedImage> {
  const dir = mediaDir(ctx);
  let buf: Buffer;
  try {
    buf = readFileSync(src);
  } catch (err) {
    return { ok: false, code: 'image.unreadable', message: err instanceof Error ? err.message : String(err) };
  }
  const decoded = sniffImage(buf) === 'image/png' ? decodePng(buf) : decodeBmp(buf);
  if (decoded) return prepareDecoded(cropRgba(decoded, rect.x, rect.y, rect.width, rect.height), dir);
  if (!ctx.fitImage) return { ok: false, code: 'image.too_large', message: 'only 8-bit PNG and BMP can be cut here' };
  mkdirSync(dir, { recursive: true });
  const copy = await ctx.fitImage(src, dir, rect).catch(() => undefined);
  if (!copy) return { ok: false, code: 'image.unreadable', message: 'the part could not be cut from this picture' };
  const again = prepareImage(copy, dir);
  if (again.ok && again.image.path !== copy) rmSync(copy, { force: true });
  return again;
}

/** read_file on a picture file; with `region`, only that part, at the picture's own detail when it fits the limits. */
export async function readPicture(abs: string, info: Stats, shown: string, ctx: ToolContext, region?: Region): Promise<ToolOutput> {
  const size = await pictureSize(abs);
  const card: FileCardMeta = {
    path: abs,
    name: basename(abs),
    kind: 'other',
    sizeBytes: info.size,
    modifiedAt: isoNow(info.mtime),
    extractedAt: isoNow(),
    read: {},
    ...(size ? { image: size } : {}),
  };
  const head = `${shown} (picture${size ? `, ${size.width}x${size.height} px` : ''}, ${info.size} bytes, modified ${isoNow(info.mtime)})`;
  if (ctx.imagesAllowed === false) {
    ctx.emit({ type: 'file.card', callId: ctx.callId, file: card });
    return { content: `${head}\n${NO_IMAGES}` };
  }
  if (region) {
    if (!size) return { content: `${head}\nThe size of this picture cannot be read, so a part of it cannot be cut.`, isError: true };
    const rect = regionPixels(region, size.width, size.height);
    const p = await fitPart(abs, rect, ctx);
    if (!p.ok) return { content: `${head}\nThe part cannot be sent: ${p.message}.`, isError: true };
    ctx.emit({ type: 'file.card', callId: ctx.callId, file: card });
    const img = p.image;
    const full = img.width >= rect.width && img.height >= rect.height;
    const where = `pixels ${rect.x}-${rect.x + rect.width} across and ${rect.y}-${rect.y + rect.height} down`;
    const sent = full
      ? `${img.width}x${img.height} px, the picture's full detail`
      : `${img.width}x${img.height} px, ${Math.round((img.width / rect.width) * 100)}% of the picture's full detail; a smaller region shows more`;
    const tokens = imageTokens(ctx.providerKind ?? '', img.width, img.height);
    // a picture within the limits goes whole at its own size: a part of it adds no detail
    const nothingMore = Math.max(size.width, size.height) <= IMAGE_LIMITS.maxLongSide && info.size <= IMAGE_LIMITS.maxBytes
      ? `\nThe whole picture is sent at this same detail when read without region; a part of it shows nothing more.`
      : '';
    return {
      content: `${head}\nThe part (${where}) follows as an image: ${sent}, about ${tokens} tokens.${nothingMore}`,
      images: [block(img, `${basename(abs)} part`)],
    };
  }
  const p = await fit(abs, ctx);
  if (!p.ok) return { content: `${head}\nThe picture cannot be sent: ${p.message}.`, isError: true };
  ctx.emit({ type: 'file.card', callId: ctx.callId, file: card });
  const img = p.image;
  const smaller = size ? Math.max(size.width, size.height) > Math.max(img.width, img.height) : img.resized;
  const sent = img.resized ? `a smaller copy, ${img.width}x${img.height} px (${kb(img.bytes)})` : `${img.width}x${img.height} px`;
  const tokens = imageTokens(ctx.providerKind ?? '', img.width, img.height);
  const hint = smaller && size ? `\n${zoomHint(Math.max(size.width, size.height), Math.max(img.width, img.height), 'Call read_file again with')}` : '';
  return {
    content: `${head}\nThe picture follows as an image: ${sent}, about ${tokens} tokens.${hint}`,
    images: [block(img, basename(abs))],
  };
}

/**
 * An attached picture that went as a smaller copy: the original kept in the conversation's media folder (an attached
 * file may be a pasted screenshot's temporary file), and the sentence that tells the model how to look closer.
 */
export async function keepOriginal(src: string, sent: { width: number; height: number }, dir: string): Promise<string | undefined> {
  const size = await pictureSize(src);
  if (!size || Math.max(size.width, size.height) <= Math.max(sent.width, sent.height)) return undefined;
  let buf: Buffer;
  try {
    buf = readFileSync(src);
  } catch {
    return undefined;
  }
  // under its own name (the card shows it), in a folder named by its content
  const folder = join(dir, `original-${createHash('sha256').update(buf).digest('hex').slice(0, 20)}`);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, basename(src));
  writeFileSync(path, buf);
  return `[The picture is ${size.width}x${size.height} px; the copy above is ${sent.width}x${sent.height} px. ${zoomHint(Math.max(size.width, size.height), Math.max(sent.width, sent.height), `Call read_file with path="${path}" and`)}]`;
}

/**
 * Most bytes one read's page pictures may take: what a request carries (REQUEST_IMAGE_LIMITS, as base64) less a
 * quarter for the conversation's other pictures; pages past it wait for the next read, so none is left out unseen.
 */
export const PAGE_PICTURE_BYTES = Math.floor((REQUEST_IMAGE_LIMITS.maxBase64Bytes * 0.75 * 3) / 4);

/** PDF pages drawn as pictures, as images for the model (each page encoded and checked like an attached image). */
export async function pagePictures(pages: readonly PageImage[], fileName: string, ctx: ToolContext, maxBytes = PAGE_PICTURE_BYTES): Promise<{ images: ImageBlock[]; note: string }> {
  const dir = mediaDir(ctx);
  mkdirSync(dir, { recursive: true });
  const images: ImageBlock[] = [];
  const shown: number[] = [];
  const failed: number[] = [];
  const later: number[] = [];
  let tokens = 0;
  let bytes = 0;
  for (const pg of pages) {
    if (later.length > 0) {
      later.push(pg.page);
      continue;
    }
    const png = await encodePngCompact({ width: pg.width, height: pg.height, data: pg.rgba });
    const raw = join(dir, `page-${createHash('sha256').update(png).digest('hex').slice(0, 20)}.png`);
    writeFileSync(raw, png);
    const p = prepareImage(raw, dir);
    if (!p.ok) {
      rmSync(raw, { force: true });
      failed.push(pg.page);
      continue;
    }
    if (p.image.path !== raw) rmSync(raw, { force: true });
    if (images.length > 0 && bytes + p.image.bytes > maxBytes) {
      later.push(pg.page);
      continue;
    }
    bytes += p.image.bytes;
    images.push(block(p.image, `${fileName} page ${pg.page}${pg.region ? ' part' : ''}`));
    shown.push(pg.page);
    tokens += imageTokens(ctx.providerKind ?? '', p.image.width, p.image.height);
  }
  const lines: string[] = [];
  const parts = pages.some((pg) => pg.region);
  if (shown.length > 0 && parts) {
    lines.push(`[The part follows as an image, about ${tokens} tokens.]`);
  } else if (shown.length > 0) {
    lines.push(`[${shown.length} page picture${shown.length === 1 ? '' : 's'} follow${shown.length === 1 ? 's' : ''} as images (page${shown.length === 1 ? '' : 's'} ${shown.join(', ')}), about ${tokens} tokens in all.]`);
  }
  if (shown.length > 0 && !parts) {
    lines.push(`[Small text may not be legible at this size. Call read_file with pages="${shown[0]}" and region="left,top,right,bottom" (percent of the page's width and height, e.g. "0,0,50,50" for the top left quarter) to see a part of one page in more detail.]`);
  }
  if (later.length > 0) {
    lines.push(`[Pages ${later.join(', ')} were drawn but not sent, to keep the request within its size limit. Call read_file again with pages="${later.join(',')}" to see them.]`);
  }
  if (failed.length > 0) lines.push(`[Pages ${failed.join(', ')} could not be made into pictures within the size limit.]`);
  return { images, note: lines.join('\n') };
}
