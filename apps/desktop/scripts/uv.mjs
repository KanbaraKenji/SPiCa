// The uv the app carries (core python-env.ts: the app's own Python is downloaded by it after the user confirms).
// Not in the repository: fetched at build time, pinned to one release and its SHA-256, into apps/desktop/uv/uv.exe;
// electron-builder ships that folder as resources/uv. Runs before dev, preview, build and dist (Windows only: the
// pinned file is the Windows x64 build).
//
// Where from: the official release on GitHub, or a copy of the same zip named by SPICA_UV_ZIP (a build machine
// without access to github.com). Either way the zip must match the pinned SHA-256.
// When it cannot be had (no network, a different file): a warning, and the build goes on without it. The app then
// offers no python_env: the model is told there is no Python (Node scripts as before), and nothing asks to download.
//
// To update uv: change UV.version and UV.sha256 (from the release's .sha256 file) together.
//   node scripts/uv.mjs
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const UV = {
  version: '0.13.8',
  asset: 'uv-x86_64-pc-windows-msvc.zip',
  sha256: '529e78a9cec6cd7e3e014f7ecd8bda0c113969d4ed0f2efeedb85c30943325b8',
};

export const uvUrl = (u = UV) => `https://github.com/astral-sh/uv/releases/download/${u.version}/${u.asset}`;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Make sure <outDir>/uv.exe is the pinned uv. Returns { ok, how } (how: 'present' | 'downloaded' | 'local'), or
 * { ok: false, why } without throwing. `opts.zip` / `opts.pin` / `opts.download` are for tests.
 */
export async function fetchUv(outDir = join(appDir, 'uv'), opts = {}) {
  const pin = opts.pin ?? UV;
  const exe = join(outDir, 'uv.exe');
  const stamp = join(outDir, 'version.txt');
  if (existsSync(exe) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === `${pin.version} ${pin.sha256}`) return { ok: true, how: 'present' };
  let zip;
  let how;
  const local = opts.zip ?? process.env.SPICA_UV_ZIP;
  try {
    if (local) {
      zip = readFileSync(local);
      how = 'local';
    } else {
      const download = opts.download ?? (async (url) => {
        const r = await fetch(url, { redirect: 'follow' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      });
      zip = await download(uvUrl(pin));
      how = 'downloaded';
    }
  } catch (e) {
    return { ok: false, why: `could not get ${local ?? uvUrl(pin)}: ${e instanceof Error ? e.message : e}` };
  }
  const got = sha256(zip);
  if (got !== pin.sha256) return { ok: false, why: `SHA-256 ${got} is not the pinned ${pin.sha256} (uv ${pin.version})` };
  // unpack in a folder of its own, keep only uv.exe
  const tmp = mkdtempSync(join(tmpdir(), 'spica-uv-'));
  try {
    const file = join(tmp, pin.asset);
    writeFileSync(file, zip);
    const out = join(tmp, 'x');
    mkdirSync(out);
    // Windows 10 and later have tar.exe (bsdtar), which reads zip; by its full path, not a GNU tar on PATH (Git's)
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
    const r = spawnSync(tar, ['-xf', file, '-C', out], { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0 || !existsSync(join(out, 'uv.exe'))) return { ok: false, why: `could not unpack ${pin.asset}: ${(r.stderr || r.error?.message || 'no uv.exe in it').trim()}` };
    mkdirSync(outDir, { recursive: true });
    copyFileSync(join(out, 'uv.exe'), exe);
    writeFileSync(stamp, `${pin.version} ${pin.sha256}\n`);
    return { ok: true, how };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'win32') {
    console.log('[uv] not Windows: skipped (the app offers no python_env)');
  } else {
    const r = await fetchUv();
    if (r.ok) console.log(`[uv] ${UV.version} ${r.how === 'present' ? '(up to date)' : r.how === 'local' ? 'from SPICA_UV_ZIP' : 'downloaded'}`);
    else console.warn(`[uv] WARNING: no uv, so the app will not offer to download Python (python_env). ${r.why}. Set SPICA_UV_ZIP to a copy of ${UV.asset} to build without github.com.`);
  }
}
