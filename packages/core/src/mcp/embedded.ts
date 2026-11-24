// A file an MCP tool returned inside its result (EmbeddedResource with a BlobResourceContents: uri, mimeType?,
// blob in base64; no name or title in the spec): kept as a file for the user, in the conversation's working folder
// when it has one (see Session.handOverDir), else its media folder. The bytes never go to the model.
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

/** The most a kept file may be, decoded. */
export const EMBEDDED_LIMIT = 50 * 1024 * 1024;

/** Why a file was not kept: over the limit, not base64, it could not be written, or the call has no conversation (a plugin page's). */
export type NotKeptReason = 'too_large' | 'bad_data' | 'write_failed' | 'no_folder';

/** A file the result carried that was not kept: for its card (FileCardMeta.notSaved). */
export interface NotKept {
  name: string;
  reason: NotKeptReason;
  bytes?: number;
}

const MB = 1024 * 1024;

/** What the model is told after `文件 <name> 没有保存：`. */
export function notKeptWords(k: { reason: NotKeptReason; bytes?: number; error?: string }): string {
  if (k.reason === 'too_large') return `超过 ${EMBEDDED_LIMIT / MB} MB 的上限（${((k.bytes ?? 0) / MB).toFixed(1)} MB）`;
  if (k.reason === 'bad_data') return '内容不是有效的 base64';
  if (k.reason === 'no_folder') return '这次调用不在对话里，没有地方存';
  return `写入失败${k.error ? `（${k.error}）` : ''}`;
}

export type KeptEmbedded =
  | { ok: true; path: string; bytes: number }
  | { ok: false; reason: NotKeptReason; name: string; bytes?: number; error?: string };

const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/zip': 'zip',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/markdown': 'md',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
};

/** Names Windows keeps for devices, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const MAX_NAME = 120;

/** The file name a uri gives: its last part, percent-decoded, made safe; '' when it gives none. */
export function nameFromUri(uri: string): string {
  let s = uri.replace(/[?#].*$/s, '');
  try {
    s = decodeURIComponent(s);
  } catch {
    // a broken escape: the text as it is
  }
  const last = s.split(/[\\/]/).pop() ?? '';
  return safeName(last.replace(/^[a-z][a-z0-9+.-]*:/i, ''));
}

/** A name that is one file name in any folder: no separators, no characters Windows refuses, not a device. */
export function safeName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let s = raw.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim();
  if (s === '' || /^\.+$/.test(s)) return '';
  if (RESERVED.test(s)) s = `_${s}`;
  if (s.length > MAX_NAME) {
    const ext = extname(s);
    const keep = ext.length > 0 && ext.length <= 16 ? ext : '';
    s = s.slice(0, MAX_NAME - keep.length) + keep;
  }
  return s;
}

/** The size base64 text decodes to, or undefined when it is not base64 (padding only at the end, length a multiple of 4). */
export function base64Size(data: string): number | undefined {
  const s = data.replace(/\s+/g, '');
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return undefined;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}

/** The name a kept file gets: from the uri; the extension the mime type says when the name has none. */
export function embeddedName(uri: string, mimeType: string | undefined): string {
  const type = (mimeType ?? '').toLowerCase().split(';')[0]!.trim();
  const ext = MIME_EXT[type];
  const name = nameFromUri(uri) || 'file';
  return extname(name) || !ext ? name : `${name}.${ext}`;
}

/** Keep one file in `dir`, never over a file there: `name (2).ext`, ... when the name is taken. */
export function keepEmbedded(dir: string, res: { uri?: unknown; mimeType?: unknown; blob: string }): KeptEmbedded {
  const name = embeddedName(typeof res.uri === 'string' ? res.uri : '', typeof res.mimeType === 'string' ? res.mimeType : undefined);
  const size = base64Size(res.blob);
  if (size === undefined) return { ok: false, reason: 'bad_data', name };
  if (size > EMBEDDED_LIMIT) return { ok: false, reason: 'too_large', name, bytes: size };
  const bytes = Buffer.from(res.blob.replace(/\s+/g, ''), 'base64');
  try {
    mkdirSync(dir, { recursive: true });
    const root = resolve(dir);
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; n < 1000; n++) {
      const path = join(root, n === 1 ? name : `${stem} (${n})${ext}`);
      if (dirname(path) !== root) return { ok: false, reason: 'write_failed', name, error: 'outside the folder' };
      let fd: number;
      try {
        fd = openSync(path, 'wx');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      try {
        writeFileSync(fd, bytes);
      } catch (err) {
        closeSync(fd);
        rmSync(path, { force: true }); // not half a file
        throw err;
      }
      closeSync(fd);
      return { ok: true, path, bytes: bytes.length };
    }
    return { ok: false, reason: 'write_failed', name, error: 'too many files with this name' };
  } catch (err) {
    return { ok: false, reason: 'write_failed', name, error: err instanceof Error ? err.message : String(err) };
  }
}
