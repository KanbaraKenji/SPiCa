// Images and audio an MCP tool returned (base64 in the result, MCP 2025-06-18
// ImageContent / AudioContent): kept as files in the conversation's media
// folder (deleted with the conversation), so they get a file card and, for
// images, go to the model like an attached image.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareImage, sniffImage } from '../images.ts';
import type { ImageBlock } from '../types.ts';

export interface KeptMedia {
  path: string;
  /** For an image within the limits (or made smaller): the block that goes to the model. */
  image?: ImageBlock;
}

const AUDIO_EXT: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
};
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' };

/** Keep one image or audio item in `dir`; undefined when there is nothing to keep. */
export function keepMedia(dir: string, kind: 'image' | 'audio', data: string, mimeType: string): KeptMedia | undefined {
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0) return undefined;
  mkdirSync(dir, { recursive: true });
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 20);
  const type = mimeType.toLowerCase().split(';')[0]!.trim();
  if (kind === 'audio') {
    const path = join(dir, `${hash}.${AUDIO_EXT[type] ?? 'audio'}`);
    writeFileSync(path, bytes);
    return { path };
  }
  const sniffed = sniffImage(bytes);
  const raw = join(dir, `tool-${hash}.${IMAGE_EXT[sniffed ?? type] ?? 'img'}`);
  writeFileSync(raw, bytes);
  if (!sniffed) return { path: raw }; // not a kind the models take (SVG, BMP, ...): a file only
  // the same checks and making-smaller as an attached image
  const prepared = prepareImage(raw, dir);
  if (!prepared.ok) return { path: raw };
  if (prepared.image.path !== raw) rmSync(raw, { force: true });
  const { path, mediaType, width, height, bytes: size } = prepared.image;
  return { path, image: { type: 'image', path, mediaType, width, height, bytes: size } };
}
