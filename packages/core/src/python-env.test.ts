// The app's own Python (python-env.ts), with a stand-in for uv (testing/fake-uv.mjs) and a local package index:
// every uv call keeps to the app's folder, what a download would be is worked out before anything is fetched,
// and installing, listing and clearing work.
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureNetwork } from './net.ts';
import {
  clearPython,
  envBinDir,
  envPython,
  installPython,
  listPackages,
  normalizeName,
  packageBytes,
  parseDryRun,
  parsePins,
  planPackages,
  pythonDownload,
  pythonEnvStatus,
  uvEnv,
  UvError,
  type PythonEnvOptions,
} from './python-env.ts';
import { tempDir } from './testing/helpers.ts';

const fakeUv = join(import.meta.dirname, 'testing', 'fake-uv.mjs');

let server: Server;
let base: string;
beforeAll(async () => {
  configureNetwork({ proxy: null, caFile: null, useSystemCa: false });
  server = createServer((req, res) => {
    if (req.url === '/python.tar.gz') {
      res.writeHead(200, { 'content-length': String(31_000_000), 'content-type': 'application/gzip' });
      return void res.end(req.method === 'HEAD' ? undefined : '');
    }
    const m = /^\/simple\/([^/]+)\/$/.exec(req.url ?? '');
    const files: Record<string, { filename: string; size: number }[]> = {
      pandas: [
        { filename: 'pandas-2.3.3-cp312-cp312-win_amd64.whl', size: 11_000_000 },
        { filename: 'pandas-2.3.3-cp313-cp313-win_amd64.whl', size: 11_500_000 },
        { filename: 'pandas-2.3.3.tar.gz', size: 4_400_000 },
        { filename: 'pandas-2.3.2-cp312-cp312-win_amd64.whl', size: 10_000_000 },
      ],
      numpy: [
        { filename: 'numpy-2.3.4-cp312-cp312-macosx_14_0_arm64.whl', size: 5_000_000 },
        { filename: 'numpy-2.3.4-cp312-cp312-win_amd64.whl', size: 12_800_000 },
      ],
      'python-dateutil': [{ filename: 'python_dateutil-2.9.0.post0-py2.py3-none-any.whl', size: 229_889 }],
    };
    if (m && files[m[1]!] && /vnd\.pypi\.simple\.v1\+json/.test(String(req.headers.accept))) {
      res.writeHead(200, { 'content-type': 'application/vnd.pypi.simple.v1+json' });
      return void res.end(JSON.stringify({ name: m[1], files: files[m[1]!] }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let dir: string;
let cleanup: () => Promise<void>;
let opts: PythonEnvOptions;
let log: string;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  log = join(dir, 'uv.log');
  writeConfig({});
  opts = { uvExe: process.execPath, uvPrefixArgs: [fakeUv, join(dir, 'fake.json')], root: join(dir, 'python'), packageIndex: `${base}/simple`, netDir: join(dir, 'net') };
});
afterEach(async () => {
  await cleanup();
});

function writeConfig(extra: { fail?: string }): void {
  writeFileSync(join(dir, 'fake.json'), JSON.stringify({ log, pythonUrl: `${base}/python.tar.gz`, ...extra }));
}

function calls(): { args: string[]; env: Record<string, string> }[] {
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { args: string[]; env: Record<string, string> })
    : [];
}

describe('uv’s environment keeps everything in the app’s folder', () => {
  it('folders under the root, no registry, no links on PATH, no uv.toml, only its own Pythons, no unasked downloads', () => {
    const env = uvEnv({ uvExe: 'uv', root: join(dir, 'p') });
    expect(env).toMatchObject({
      UV_PYTHON_INSTALL_DIR: join(dir, 'p', 'pythons'),
      UV_CACHE_DIR: join(dir, 'p', 'cache'),
      UV_PYTHON_BIN_DIR: join(dir, 'p', 'bin'),
      UV_TOOL_DIR: join(dir, 'p', 'tools'),
      UV_PYTHON_INSTALL_BIN: '0',
      UV_PYTHON_INSTALL_REGISTRY: '0',
      UV_NO_CONFIG: '1',
      UV_PYTHON_PREFERENCE: 'only-managed',
      UV_PYTHON_DOWNLOADS: 'manual',
    });
    expect(env.UV_PYTHON_INSTALL_MIRROR).toBeUndefined();
    expect(env.UV_DEFAULT_INDEX).toBeUndefined();
  });

  it('what the user set for uv or a virtual environment does not leak in', () => {
    const saved = { ...process.env };
    process.env.UV_PYTHON_INSTALL_DIR = 'C:\\elsewhere';
    process.env.UV_INDEX_URL = 'https://other.example.com/simple';
    process.env.VIRTUAL_ENV = 'C:\\proj\\.venv';
    try {
      const env = uvEnv({ uvExe: 'uv', root: join(dir, 'p') });
      expect(env.UV_PYTHON_INSTALL_DIR).toBe(join(dir, 'p', 'pythons'));
      expect(env.UV_INDEX_URL).toBeUndefined();
      expect(env.VIRTUAL_ENV).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });

  it('a company mirror and package index (deploy.json) are passed on', () => {
    const env = uvEnv({ uvExe: 'uv', root: dir, pythonMirror: 'https://mirror.example.com/python', packageIndex: 'https://pypi.example.com/simple' });
    expect(env.UV_PYTHON_INSTALL_MIRROR).toBe('https://mirror.example.com/python');
    expect(env.UV_DEFAULT_INDEX).toBe('https://pypi.example.com/simple');
  });

  it('the app’s proxy (with its login) and certificates go to uv', () => {
    try {
      configureNetwork({ proxy: { url: 'http://user:pw@proxy.example.com:8080', noProxy: ['intra.example.com'] }, caFile: null, useSystemCa: false });
      const env = uvEnv({ uvExe: 'uv', root: dir, netDir: join(dir, 'net') });
      expect(env.HTTPS_PROXY).toBe('http://user:pw@proxy.example.com:8080/');
      expect(env.NO_PROXY).toContain('intra.example.com');
      expect(env.UV_SYSTEM_CERTS).toBe('true');
    } finally {
      configureNetwork({ proxy: null, caFile: null, useSystemCa: false });
    }
  });
});

describe('before downloading: what and how big', () => {
  it('the CPython uv would download, and its size from the server', async () => {
    expect(await pythonDownload(opts)).toEqual({ version: '3.12.16', url: `${base}/python.tar.gz`, bytes: 31_000_000 });
    expect(calls()[0]!.args).toEqual(['python', 'list', '3.12', '--only-downloads', '--output-format', 'json']);
  });

  it('packages before the environment exists: resolved for that Python, sized from the index', async () => {
    expect(await planPackages(opts, ['pandas'])).toEqual([
      { name: 'pandas', version: '2.3.3', bytes: 11_000_000 },
      { name: 'numpy', version: '2.3.4', bytes: 12_800_000 },
    ]);
    expect(calls()[0]!.args).toEqual(['pip', 'compile', '-', '--python-version', '3.12', '--no-header', '--no-annotate', '--quiet']);
    expect(existsSync(opts.root)).toBe(false); // nothing downloaded or made
  });

  it('packages after: only what is not there yet (dry run against the environment)', async () => {
    await installPython(opts, ['numpy']);
    expect(await planPackages(opts, ['pandas'])).toEqual([{ name: 'pandas', version: '2.3.3', bytes: 11_000_000 }]);
    expect(calls().at(-1)!.args).toEqual(['pip', 'install', '--dry-run', '--python', envPython(opts.root), 'pandas']);
  });

  it('an index that gives no sizes, or no such package: size unknown, not an error', async () => {
    expect(await packageBytes(`${base}/simple`, { name: 'nothing-here', version: '1.0.0' }, '3.12')).toEqual({});
    expect(await packageBytes('http://127.0.0.1:1/simple', { name: 'pandas', version: '2.3.3' }, '3.12')).toEqual({});
    expect(await packageBytes(`${base}/simple`, { name: 'python_dateutil', version: '2.9.0.post0' }, '3.12')).toEqual({ bytes: 229_889 });
  });

  it('reads uv’s pins and dry-run lines', () => {
    expect(parsePins('pandas==2.3.3\nnumpy==2.3.4 ; python_version >= "3.10"\n# comment\nrequests[socks]==2.32.0\n')).toEqual([
      { name: 'pandas', version: '2.3.3' },
      { name: 'numpy', version: '2.3.4' },
      { name: 'requests', version: '2.32.0' },
    ]);
    expect(parseDryRun('Resolved 3 packages in 12ms\nWould download 2 packages\nWould install 2 packages\n + numpy==2.3.4\n + pandas==2.3.3\n')).toEqual([
      { name: 'numpy', version: '2.3.4' },
      { name: 'pandas', version: '2.3.3' },
    ]);
    expect(normalizeName('Python_Dateutil.x')).toBe('python-dateutil-x');
  });
});

describe('installing, listing, clearing', () => {
  it('first time: Python, then an environment without pip, then the packages', async () => {
    const steps: string[] = [];
    const pkgs = await installPython(opts, ['pandas'], { onStep: (s) => steps.push(s) });
    expect(steps).toEqual(['python', 'env', 'packages']);
    expect(pkgs).toEqual([
      { name: 'pandas', version: '2.3.3' },
      { name: 'numpy', version: '2.3.4' },
    ]);
    const args = calls().map((c) => c.args);
    expect(args[0]).toEqual(['python', 'install', '3.12', '--no-bin', '--no-registry']);
    expect(args[1]).toEqual(['venv', '--python', '3.12', '--no-project', join(opts.root, 'env')]);
    expect(args[1]).not.toContain('--seed');
    expect(args[2]).toEqual(['pip', 'install', '--python', envPython(opts.root), 'pandas']);
    // every call ran with the app's folders
    for (const c of calls()) expect(c.env.UV_PYTHON_INSTALL_DIR).toBe(join(opts.root, 'pythons'));
    const st = pythonEnvStatus(opts.root);
    expect(st).toMatchObject({ ready: true, version: '3.12.16', python: envPython(opts.root) });
    expect(st.bytes).toBeGreaterThan(0);
    expect(envBinDir(opts.root)).toBe(join(opts.root, 'env', process.platform === 'win32' ? 'Scripts' : 'bin'));
  });

  it('later: only the packages', async () => {
    await installPython(opts, []);
    const before = calls().length;
    await installPython(opts, ['openpyxl']);
    expect(calls().slice(before).map((c) => c.args.slice(0, 2).join(' '))).toEqual(['pip install', 'pip list']);
    expect(await listPackages(opts)).toEqual([{ name: 'openpyxl', version: '1.0.0' }]);
  });

  it('a failing download says what uv said', async () => {
    writeConfig({ fail: 'pip install' });
    await installPython(opts, []);
    const err = await installPython(opts, ['nope']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UvError);
    expect((err as UvError).message).toContain('Failed to fetch');
  });

  it('nothing there: not ready, nothing used; clearing removes it all', async () => {
    expect(pythonEnvStatus(opts.root)).toEqual({ ready: false, bytes: 0 });
    expect(await listPackages(opts)).toEqual([]);
    await installPython(opts, ['pandas']);
    clearPython(opts.root);
    expect(existsSync(opts.root)).toBe(false);
    expect(pythonEnvStatus(opts.root)).toEqual({ ready: false, bytes: 0 });
  });
});
