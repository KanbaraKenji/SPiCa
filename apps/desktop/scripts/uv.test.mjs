// Fetching uv at build time: only the pinned file is accepted; anything else leaves the app without it, saying why.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fetchUv, pythonSwitchedOff, UV, uvUrl } from './uv.mjs';

const dir = mkdtempSync(join(tmpdir(), 'spica-uv-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A zip with a uv.exe in it (Windows' own tar writes zip). */
function fakeZip() {
  const src = join(dir, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'uv.exe'), 'not really uv');
  writeFileSync(join(src, 'uvx.exe'), 'nor this');
  const zip = join(dir, 'uv.zip');
  const tar = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe');
  const r = spawnSync(tar, ['-a', '-c', '-f', zip, '-C', src, 'uv.exe', 'uvx.exe'], { windowsHide: true });
  if (r.status !== 0) throw new Error('could not make a zip');
  return zip;
}

describe.runIf(process.platform === 'win32')('uv at build time', () => {
  it('pinned to the official release', () => {
    expect(uvUrl()).toBe(`https://github.com/astral-sh/uv/releases/download/${UV.version}/uv-x86_64-pc-windows-msvc.zip`);
    expect(UV.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a zip matching the pin: only uv.exe is kept, with the version; a second run does nothing', async () => {
    const zip = fakeZip();
    const pin = { ...UV, sha256: createHash('sha256').update(readFileSync(zip)).digest('hex') };
    const out = join(dir, 'out1');
    expect(await fetchUv(out, { zip, pin })).toEqual({ ok: true, how: 'local' });
    expect(readFileSync(join(out, 'uv.exe'), 'utf8')).toBe('not really uv');
    expect(existsSync(join(out, 'uvx.exe'))).toBe(false);
    expect(await fetchUv(out, { zip: join(dir, 'missing.zip'), pin })).toEqual({ ok: true, how: 'present' });
  });

  it('anything else: no uv.exe, and why', async () => {
    const zip = fakeZip();
    const out = join(dir, 'out2');
    const wrong = await fetchUv(out, { zip }); // the real pin: this zip does not match
    expect(wrong.ok).toBe(false);
    expect(wrong.why).toContain('is not the pinned');
    const offline = await fetchUv(out, { download: async () => Promise.reject(new Error('getaddrinfo ENOTFOUND github.com')) });
    expect(offline).toMatchObject({ ok: false });
    expect(offline.why).toContain('ENOTFOUND');
    expect(existsSync(join(out, 'uv.exe'))).toBe(false);
  });
});

describe('deploy.json switching the app’s Python off', () => {
  it('only python.enabled false counts; no file, or a file that does not say, does not', () => {
    const at = (json) => {
      const d = mkdtempSync(join(dir, 'deploy-'));
      if (json !== undefined) writeFileSync(join(d, 'deploy.json'), JSON.stringify(json));
      return d;
    };
    expect(pythonSwitchedOff(at(undefined))).toBe(false);
    expect(pythonSwitchedOff(at({ models: [] }))).toBe(false);
    expect(pythonSwitchedOff(at({ python: { enabled: true } }))).toBe(false);
    expect(pythonSwitchedOff(at({ python: { enabled: false } }))).toBe(true);
  });
});
