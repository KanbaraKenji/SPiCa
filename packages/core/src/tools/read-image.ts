// read_file on a picture, and the PDF pages a document reader drew as pictures (scanned pages): the copy that goes to
// the model, made with the same checks and shrinking as an attached image (images.ts; the host shrinks what the core
// cannot, Runtime.imageFitter), or a sentence saying why it cannot go.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { isoNow } from '../events.ts';
import { encodePngCompact, imageTokens, prepareImage, REQUEST_IMAGE_LIMITS, type PreparedImage } from '../images.ts';
import type { FileCardMeta, ImageBlock } from '../types.ts';
import { PICTURE_EXTENSIONS, pictureSize } from './file-card.ts';
import type { PageImage, ToolContext, ToolOutput } from './types.ts';

/** Files read_file hands to the model as pictures (the ones whose card says picture). */
export { PICTURE_EXTENSIONS };

/** The sentence for a model that does not take images. */
export const NO_IMAGES = 'The current model does not take images, so it cannot be shown; a model that takes images can look at it.';

function mediaDir(ctx: ToolContext): string {
  return ctx.mediaDir ?? join(tmpdir(), 'spica-media', ctx.sessionId.replace(/[^A-Za-z0-9_-]/g, '_'));
}

/** The picture at `src` within the limits: by the core's own checks, else the host's smaller copy. */
async function fit(src: string, ctx: ToolContext): Promise<PreparedImage> {
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

/** read_file on a picture file. */
export async function readPicture(abs: string, info: Stats, shown: string, ctx: ToolContext): Promise<ToolOutput> {
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
  const p = await fit(abs, ctx);
  if (!p.ok) return { content: `${head}\nThe picture cannot be sent: ${p.message}.`, isError: true };
  ctx.emit({ type: 'file.card', callId: ctx.callId, file: card });
  const img = p.image;
  const sent = img.resized ? `a smaller copy, ${img.width}x${img.height} px (${kb(img.bytes)})` : `${img.width}x${img.height} px`;
  const tokens = imageTokens(ctx.providerKind ?? '', img.width, img.height);
  return {
    content: `${head}\nThe picture follows as an image: ${sent}, about ${tokens} tokens.`,
    images: [block(img, basename(abs))],
  };
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
    images.push(block(p.image, `${fileName} page ${pg.page}`));
    shown.push(pg.page);
    tokens += imageTokens(ctx.providerKind ?? '', p.image.width, p.image.height);
  }
  const lines: string[] = [];
  if (shown.length > 0) {
    lines.push(`[${shown.length} page picture${shown.length === 1 ? '' : 's'} follow${shown.length === 1 ? 's' : ''} as images (page${shown.length === 1 ? '' : 's'} ${shown.join(', ')}), about ${tokens} tokens in all.]`);
  }
  if (later.length > 0) {
    lines.push(`[Pages ${later.join(', ')} were drawn but not sent, to keep the request within its size limit. Call read_file again with pages="${later.join(',')}" to see them.]`);
  }
  if (failed.length > 0) lines.push(`[Pages ${failed.join(', ')} could not be made into pictures within the size limit.]`);
  return { images, note: lines.join('\n') };
}
