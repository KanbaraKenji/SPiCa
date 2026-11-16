// A Python the app manages for the Agent's scripts, the way Claude Desktop's `uv` extensions get theirs: the app
// carries uv (Astral's Python package manager) and, after the user confirms, has it download a standalone Python
// (python-build-standalone) and the packages a task needs into the app's data folder:
//
//   <root>/pythons   the interpreters uv downloaded
//   <root>/cache     uv's download cache
//   <root>/env       one virtual environment every conversation shares (packages installed once)
//
// Nothing else on the computer changes: every uv call gets its environment from uvEnv(), which points all of
// uv's folders under <root>, turns off the Windows registry entries and the links uv would put into
// %USERPROFILE%\.local\bin, ignores uv.toml files (the user's and any project's), only uses Pythons uv itself
// installed, and never downloads one unasked. The variables come from uv's own reference:
// https://docs.astral.sh/uv/reference/environment/ (and storage, python-versions, configuration-files).
//
// Only the app runs uv, and the environment is made without pip (`uv venv` seeds none), so the way to add a
// package is this module, after the confirmation the caller asks for. That is the default path, not a wall: a
// command could still bootstrap pip (python -m ensurepip). Package requests are names with optional version
// conditions only (packageSpecProblem): no options, files or URLs that would pass the configured index by.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv } from './util.ts';
import { netFetch, networkSecrets, networkStatus, withNetworkEnv } from './net.ts';

export interface PythonEnvOptions {
  /** The uv executable the app carries. */
  uvExe: string;
  /** The app's folder for all of it (e.g. <userData>/python). */
  root: string;
  /** Which Python to download (uv request syntax). Default '3.12'. */
  pythonVersion?: string;
  /** Where Python downloads come from instead of uv's default (deploy.json; a company mirror, file:// works). */
  pythonMirror?: string;
  /** The package index instead of PyPI (deploy.json; a company index). */
  packageIndex?: string;
  /** Where the network settings' certificate files go for uv (default: the temp folder). */
  netDir?: string;
  /** Arguments put before uv's own (tests: uvExe is a Node and this the stand-in script). */
  uvPrefixArgs?: string[];
}

export const DEFAULT_PYTHON = '3.12';
/** PyPI's simple index, when no packageIndex is set. */
export const PYPI_SIMPLE = 'https://pypi.org/simple';

/** The folders under the root. */
export function pythonDirs(root: string): { pythons: string; cache: string; env: string; bin: string; tools: string } {
  return { pythons: join(root, 'pythons'), cache: join(root, 'cache'), env: join(root, 'env'), bin: join(root, 'bin'), tools: join(root, 'tools') };
}

/** The environment's python executable. */
export function envPython(root: string): string {
  const env = pythonDirs(root).env;
  return process.platform === 'win32' ? join(env, 'Scripts', 'python.exe') : join(env, 'bin', 'python');
}

/** The folder with the environment's programs (what goes on run_command's PATH). */
export function envBinDir(root: string): string {
  const env = pythonDirs(root).env;
  return process.platform === 'win32' ? join(env, 'Scripts') : join(env, 'bin');
}

/**
 * The one environment every uv call runs in. Starts from the short list of system variables (no UV_*, no
 * VIRTUAL_ENV or CONDA_PREFIX the user may have set), adds the app's network settings (proxy with its login,
 * extra certificates as SSL_CERT_FILE), then uv's own settings.
 */
export function uvEnv(opts: PythonEnvOptions): Record<string, string> {
  const d = pythonDirs(opts.root);
  const env: Record<string, string> = withNetworkEnv(childEnv(), opts.netDir);
  Object.assign(env, {
    UV_PYTHON_INSTALL_DIR: d.pythons,
    UV_CACHE_DIR: d.cache,
    UV_PYTHON_BIN_DIR: d.bin,
    UV_TOOL_DIR: d.tools,
    UV_TOOL_BIN_DIR: join(d.tools, 'bin'),
    UV_PYTHON_INSTALL_BIN: '0',
    UV_PYTHON_INSTALL_REGISTRY: '0',
    UV_NO_CONFIG: '1',
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_PYTHON_DOWNLOADS: 'manual',
    UV_NO_PROGRESS: '1',
    NO_COLOR: '1',
  });
  // the certificates the app trusts: SSL_CERT_FILE holds them all when there are any beyond the usual list
  // (system store, CA file); with only the system store switched on, uv reads that store itself
  if (!env.SSL_CERT_FILE && networkStatus().useSystemCa) env.UV_SYSTEM_CERTS = 'true';
  if (opts.pythonMirror) env.UV_PYTHON_INSTALL_MIRROR = opts.pythonMirror;
  if (opts.packageIndex) env.UV_DEFAULT_INDEX = opts.packageIndex;
  return env;
}

export class UvError extends Error {
  /** What uv printed (stdout and stderr). */
  readonly output: string;
  constructor(message: string, output: string) {
    super(message);
    this.output = output;
  }
}

/**
 * Run uv with `args` (stdin: `input`). Resolves with what it wrote on stdout and stderr (uv prints plans and
 * progress on stderr); rejects with UvError, its output attached, when it fails.
 */
export function uvCall(opts: PythonEnvOptions, args: string[], o: { input?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      opts.uvExe,
      [...(opts.uvPrefixArgs ?? []), ...args],
      { env: uvEnv(opts), windowsHide: true, encoding: 'utf8', timeout: o.timeoutMs ?? 15 * 60_000, maxBuffer: 32 * 1024 * 1024, ...(o.signal ? { signal: o.signal } : {}) },
      (err, stdout, stderr) => {
        const out = { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
        // uv may echo the proxy address with its login in an error
        if (err) reject(new UvError(redact(`uv ${args.slice(0, 2).join(' ')} failed: ${lastLine(out.stderr) || lastLine(out.stdout) || err.message}`), redact(`${out.stdout}\n${out.stderr}`.trim())));
        else resolve(out);
      },
    );
    child.stdin?.end(o.input ?? '');
  });
}

function redact(s: string): string {
  let out = s;
  for (const secret of networkSecrets()) for (const form of new Set([secret, encodeURIComponent(secret)])) if (form) out = out.split(form).join('***');
  return out;
}

function lastLine(s: string): string {
  return s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
}

/** One installed package. */
export interface PythonPackage {
  name: string;
  version: string;
}

export interface PythonEnvStatus {
  /** The environment exists and has a python. */
  ready: boolean;
  /** Its Python version (from pyvenv.cfg). */
  version?: string;
  python?: string;
  /** Bytes used under the root (interpreters, cache, environment). */
  bytes: number;
}

/** What is there now, without running anything. */
export function pythonEnvStatus(root: string): PythonEnvStatus {
  const py = envPython(root);
  const bytes = folderBytes(root);
  if (!existsSync(py)) return { ready: false, bytes };
  let version: string | undefined;
  try {
    version = /^\s*version(?:_info)?\s*=\s*(\S+)/m.exec(readFileSync(join(pythonDirs(root).env, 'pyvenv.cfg'), 'utf8'))?.[1];
  } catch {
    // no pyvenv.cfg
  }
  return { ready: true, ...(version ? { version } : {}), python: py, bytes };
}

/** The packages in the environment (uv pip list). */
export async function listPackages(opts: PythonEnvOptions, signal?: AbortSignal): Promise<PythonPackage[]> {
  if (!existsSync(envPython(opts.root))) return [];
  const { stdout: out } = await uvCall(opts, ['pip', 'list', '--format', 'json', '--python', envPython(opts.root)], signal ? { signal } : {});
  const rows = JSON.parse(out || '[]') as { name: string; version: string }[];
  return rows.map((r) => ({ name: r.name, version: r.version }));
}

/** A Python uv would download: its version and address (uv python list --only-downloads). */
export interface PythonDownload {
  version: string;
  url: string;
  /** Bytes, when the server says (Content-Length). */
  bytes?: number;
}

/** Which Python a first install would download, and how big it is. */
export async function pythonDownload(opts: PythonEnvOptions, signal?: AbortSignal): Promise<PythonDownload> {
  const { stdout: out } = await uvCall(opts, ['python', 'list', opts.pythonVersion ?? DEFAULT_PYTHON, '--only-downloads', '--output-format', 'json'], signal ? { signal } : {});
  const rows = JSON.parse(out || '[]') as { version: string; url: string | null; implementation?: string }[];
  const row = rows.find((r) => (r.implementation ?? 'cpython') === 'cpython' && r.url);
  if (!row?.url) throw new UvError(`no CPython ${opts.pythonVersion ?? DEFAULT_PYTHON} to download`, out);
  return { version: row.version, url: row.url, ...(await sizeOf(row.url, signal)) };
}

async function sizeOf(url: string, signal?: AbortSignal): Promise<{ bytes?: number }> {
  if (!/^https?:/i.test(url)) {
    try {
      return { bytes: statSync(new URL(url)).size };
    } catch {
      return {};
    }
  }
  try {
    const r = await netFetch(url, { method: 'HEAD', redirect: 'follow', ...(signal ? { signal } : {}) });
    const n = Number(r.headers.get('content-length'));
    return r.ok && n > 0 ? { bytes: n } : {};
  } catch {
    return {};
  }
}

/**
 * A package a request would install: its version and the size of its file when they could be worked out (the
 * index's JSON, PEP 691 / 700). Without a version, only the name the request gave is known.
 */
export interface PlannedPackage {
  name: string;
  version?: string;
  bytes?: number;
}

const NAME = String.raw`[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?`;
const CONDITION = String.raw`(?:===?|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+`;
const SPEC = new RegExp(String.raw`^${NAME}(?:\[\s*${NAME}(?:\s*,\s*${NAME})*\s*\])?(?:\s*${CONDITION}(?:\s*,\s*${CONDITION})*)?$`);

/**
 * Why a package request is refused, or undefined when it is a plain name with optional extras and version
 * conditions (`pandas`, `pandas>=2.2,<3`, `requests[socks]==2.32`). Options (`--index-url …`, `-r file`), paths,
 * URLs and direct references (`name @ url`) would reach another source than the configured index, or install
 * something other than what the card shows.
 */
export function packageSpecProblem(spec: string): string | undefined {
  const s = spec.trim();
  if (!s) return 'empty package name';
  if (s.length > 200) return 'package request too long';
  if (!SPEC.test(s)) return `not a package name with optional version conditions: ${s.slice(0, 80)}`;
  return undefined;
}

function checkSpecs(packages: string[]): string[] {
  const out = packages.map((p) => p.trim());
  for (const p of out) {
    const problem = packageSpecProblem(p);
    if (problem) throw new UvError(problem, '');
  }
  return out;
}

/**
 * What installing `packages` would add to the environment: the resolved packages (their dependencies too) not
 * there yet. Before the environment exists it resolves for the Python that would be downloaded (uv pip compile
 * --python-version); when uv cannot (no interpreter to resolve with yet), the requested names alone, versions
 * and sizes unknown. After, against the environment (uv pip install --dry-run). Sizes from the index's JSON.
 */
export async function planPackages(opts: PythonEnvOptions, packages: string[], signal?: AbortSignal): Promise<PlannedPackage[]> {
  const specs = checkSpecs(packages);
  if (specs.length === 0) return [];
  const python = opts.pythonVersion ?? DEFAULT_PYTHON;
  const sig = signal ? { signal } : {};
  let pins: PythonPackage[];
  if (existsSync(envPython(opts.root))) {
    const r = await uvCall(opts, ['pip', 'install', '--dry-run', '--python', envPython(opts.root), ...specs], sig);
    pins = parseDryRun(`${r.stdout}\n${r.stderr}`);
  } else {
    try {
      const r = await uvCall(opts, ['pip', 'compile', '-', '--python-version', python, '--no-header', '--no-annotate', '--quiet'], { input: specs.join('\n') + '\n', ...sig });
      pins = parsePins(r.stdout);
    } catch (e) {
      if (signal?.aborted) throw e;
      return specs.map((s) => ({ name: /^[A-Za-z0-9._-]+/.exec(s)![0] }));
    }
  }
  const index = opts.packageIndex ?? PYPI_SIMPLE;
  return Promise.all(pins.map(async (p) => ({ ...p, ...(await packageBytes(index, p, python, signal)) })));
}

/** `name==version` lines (uv pip compile). */
export function parsePins(out: string): PythonPackage[] {
  const pins: PythonPackage[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==([^\s;#]+)/.exec(line);
    if (m) pins.push({ name: m[1]!, version: m[2]! });
  }
  return pins;
}

/** ` + name==version` lines (uv pip install --dry-run): what would be installed. */
export function parseDryRun(out: string): PythonPackage[] {
  const pins: PythonPackage[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*\+\s*([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)/.exec(line);
    if (m) pins.push({ name: m[1]!, version: m[2]! });
  }
  return pins;
}

/** The normalized project name (PEP 503) for the index address. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * The size of the file uv would most likely take for a pinned package: a wheel for this version that fits
 * Windows x64 (or any platform) and the Python, else the source archive. From the index's JSON API (PEP 691;
 * sizes are PEP 700). Undefined when the index does not say.
 */
export async function packageBytes(index: string, pkg: PythonPackage, python: string, signal?: AbortSignal): Promise<{ bytes?: number }> {
  try {
    const url = `${index.replace(/\/+$/, '')}/${normalizeName(pkg.name)}/`;
    const r = await netFetch(url, { headers: { accept: 'application/vnd.pypi.simple.v1+json' }, ...(signal ? { signal } : {}) });
    if (!r.ok || !/json/i.test(r.headers.get('content-type') ?? '')) return {};
    const body = (await r.json()) as { files?: { filename: string; size?: number }[] };
    const files = (body.files ?? []).filter((f) => fileVersion(f.filename, pkg.name) === pkg.version);
    const cp = `cp${python.split('.').slice(0, 2).join('')}`;
    const rank = (f: string): number => {
      if (!f.endsWith('.whl')) return 9;
      if (f.includes(cp) && /win_amd64/.test(f)) return 0;
      if (/abi3/.test(f) && /win_amd64/.test(f)) return 1;
      if (/-none-any\.whl$/.test(f)) return 2;
      return 8;
    };
    const best = files.filter((f) => typeof f.size === 'number').sort((a, b) => rank(a.filename) - rank(b.filename))[0];
    return best && rank(best.filename) !== 8 ? { bytes: best.size! } : {};
  } catch {
    return {};
  }
}

/** The version in a wheel or source archive's file name, if it is `name`'s. */
function fileVersion(filename: string, name: string): string | undefined {
  const norm = normalizeName(name).replace(/-/g, '_');
  const m = /^([^-]+)-([^-]+?)(?:-|\.tar\.gz$|\.zip$)/.exec(filename);
  if (!m || normalizeName(m[1]!).replace(/-/g, '_') !== norm) return undefined;
  return m[2];
}

/** Steps of an install, for progress. */
export type InstallStep = 'python' | 'env' | 'packages';

/**
 * Make sure the environment exists (downloading Python when it does not), then install `packages` into it.
 * Call only after the user confirmed what plan said. Returns the packages now in the environment.
 */
export async function installPython(
  opts: PythonEnvOptions,
  packages: string[],
  hooks: { signal?: AbortSignal; onStep?: (step: InstallStep) => void } = {},
): Promise<PythonPackage[]> {
  const specs = checkSpecs(packages);
  // one install at a time per folder: conversations share the environment
  const prev = installing.get(opts.root) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => installNow(opts, specs, hooks));
  const tail = run.catch(() => undefined);
  installing.set(opts.root, tail);
  void tail.then(() => {
    if (installing.get(opts.root) === tail) installing.delete(opts.root);
  });
  return run;
}

const installing = new Map<string, Promise<unknown>>();

async function installNow(opts: PythonEnvOptions, specs: string[], hooks: { signal?: AbortSignal; onStep?: (step: InstallStep) => void }): Promise<PythonPackage[]> {
  const version = opts.pythonVersion ?? DEFAULT_PYTHON;
  const sig = hooks.signal ? { signal: hooks.signal } : {};
  if (!existsSync(envPython(opts.root))) {
    hooks.onStep?.('python');
    await uvCall(opts, ['python', 'install', version, '--no-bin', '--no-registry'], sig);
    hooks.onStep?.('env');
    // no --seed: the environment has no pip; packages come through this module
    await uvCall(opts, ['venv', '--python', version, '--no-project', pythonDirs(opts.root).env], sig);
  }
  if (specs.length) {
    hooks.onStep?.('packages');
    await uvCall(opts, ['pip', 'install', '--python', envPython(opts.root), ...specs], sig);
  }
  return listPackages(opts, hooks.signal);
}

/** Remove everything under the root (interpreters, cache, environment). The next use asks to download again. */
export function clearPython(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    // a python still running from it holds its files; what could go is gone, the rest stays until it ends
    throw new UvError(`could not remove everything (${(e as NodeJS.ErrnoException).code ?? "error"}): a program from it may still be running`, String(e));
  }
}

/** Total size of the files under a folder (0 when it is missing). */
export function folderBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += statSync(p).size;
        } catch {
          // gone
        }
      }
    }
  }
  return total;
}
