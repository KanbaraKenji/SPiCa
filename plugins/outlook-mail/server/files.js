// File-name helpers for save_attachments (mock backend; the PowerShell worker
// has the same rules in Get-SafeFileName / Get-UniquePath).
import { existsSync } from 'node:fs';
import { extname, isAbsolute, join, basename } from 'node:path';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A name that is safe as a Windows file name. */
export function safeFileName(name) {
  let n = basename(String(name ?? '').replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex -- control characters are exactly what Windows file names forbid
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (!n) n = 'attachment';
  const ext = extname(n);
  const stem = n.slice(0, n.length - ext.length);
  if (RESERVED.test(stem)) n = `_${n}`;
  if (n.length > 150) n = n.slice(0, 150 - ext.length) + ext;
  return n;
}

/**
 * Where to write `name` inside `folder`. Without overwrite an existing file
 * is kept and the new one gets " (1)", " (2)" … before the extension.
 * `taken` holds names already chosen in this call.
 */
export function targetPath(folder, name, overwrite, taken = new Set()) {
  const safe = safeFileName(name);
  const ext = extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = safe;
  for (let i = 1; ; i++) {
    const full = join(folder, candidate);
    const key = full.toLowerCase();
    if (!taken.has(key) && (overwrite || !existsSync(full))) {
      taken.add(key);
      return full;
    }
    candidate = `${stem} (${i})${ext}`;
  }
}

export { isAbsolute };
