// npx and uvx fetch the package they run the first time (and uvx perhaps a Python too). A service the person adds is
// never allowed to do that unasked: it is first started offline (npx refuses to install, uvx --offline), which
// works when the package is already here. When it is not, the start fails in a way we recognise, the service waits
// as 待下载, and only after the person agreed is it started again with downloads allowed (shown as 正在下载, with
// a long wait for its first answer). uvx without uv on the computer runs as the app's own uv (`uv tool run`),
// in the app's Python folder, as the app's Python download does.
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

export type Runner = 'npx' | 'uvx';

/** The uv the app carries, and the folder its Python and caches live in (core python-env.ts: pythonDirs). */
export interface BundledUv {
  exe: string;
  root: string;
}

/** What a service would download before it can start. */
export interface DownloadNeed {
  runner: Runner;
  /** The package as written (`@example/files-server`, `example-notes==1.2`). */
  package: string;
  /** uv also needs a Python of its own (none in the app's Python folder yet). */
  python: boolean;
  /** npx: the version the registry says it would fetch, and that package's unpacked size (when it could say). */
  version?: string;
  bytes?: number;
}

/** npx or uvx (also npx.cmd, uvx.exe or a full path to one). */
export function runnerOf(command: string): Runner | undefined {
  const name = basename(command.trim()).toLowerCase().replace(/\.(cmd|bat|exe)$/, '');
  return name === 'npx' || name === 'uvx' ? name : undefined;
}

/** Options that take a value (`-p x`), so the value is not the package. */
const VALUE_FLAGS: Record<Runner, Set<string>> = {
  npx: new Set(['-p', '--package', '-c', '--call', '-w', '--workspace']),
  uvx: new Set(['--from', '--with', '--with-requirements', '--with-editable', '--python', '-p', '--index', '--default-index', '--index-url', '--extra-index-url', '--directory', '--project', '--config-file', '--cache-dir']),
};

/** The package a runner's arguments name: --package / --from when given, else the first word that is not an option. */
export function packageOf(runner: Runner, args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const named = runner === 'npx' ? /^(?:-p|--package)(?:=(.+))?$/.exec(a) : /^--from(?:=(.+))?$/.exec(a);
    if (named) return named[1] ?? args[i + 1] ?? '';
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') return args[i + 1] ?? '';
    if (!a.startsWith('-')) return a;
    if (VALUE_FLAGS[runner].has(a)) i++;
  }
  return '';
}

/** The app's Python folder has a Python uv put there. */
export function hasBundledPython(uv: BundledUv): boolean {
  const dir = join(uv.root, 'pythons');
  try {
    return existsSync(dir) && readdirSync(dir).some((n) => !n.startsWith('.'));
  } catch {
    return false;
  }
}

/** The app's uv run as uvx: its own folders, no user configuration, Python only from its own folder. */
function bundledEnv(uv: BundledUv, download: boolean): Record<string, string> {
  return {
    UV_CACHE_DIR: join(uv.root, 'cache'),
    UV_TOOL_DIR: join(uv.root, 'tools'),
    UV_TOOL_BIN_DIR: join(uv.root, 'tools', 'bin'),
    UV_PYTHON_INSTALL_DIR: join(uv.root, 'pythons'),
    UV_PYTHON_BIN_DIR: join(uv.root, 'bin'),
    UV_PYTHON_INSTALL_BIN: '0',
    UV_PYTHON_INSTALL_REGISTRY: '0',
    UV_NO_CONFIG: '1',
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_PYTHON_DOWNLOADS: download ? 'automatic' : 'manual',
    UV_NO_PROGRESS: '1',
    NO_COLOR: '1',
  };
}

export interface RunnerLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * How to start a runner's service. `download` false: offline (nothing fetched; it fails if the package is not here).
 * `uvOnPath`: the computer has its own uvx; otherwise the app's uv stands in when there is one.
 */
export function runnerLaunch(runner: Runner, command: string, args: readonly string[], env: Record<string, string>, opts: { download: boolean; uv?: BundledUv; uvOnPath: boolean }): RunnerLaunch {
  if (runner === 'npx') {
    // -y would let npx install without asking: offline it is taken out, and npm is told not to install
    const rest = opts.download ? [...args] : args.filter((a) => !/^(?:-y|--yes(?:=true)?)$/.test(a));
    return { command, args: rest, env: { ...env, ...(opts.download ? { npm_config_yes: 'true' } : { npm_config_yes: 'false', npm_config_prefer_offline: 'true' }) } };
  }
  const offline = opts.download ? [] : ['--offline'];
  if (!opts.uvOnPath && opts.uv) return { command: opts.uv.exe, args: ['tool', 'run', ...offline, ...args], env: { ...bundledEnv(opts.uv, opts.download), ...env } };
  return { command, args: [...offline, ...args], env };
}

/** The offline start failed because the package (or uv's Python) is not here yet. */
export function missedDownload(runner: Runner, text: string): boolean {
  return runner === 'npx'
    ? /canceled due to missing packages|npm (?:error|ERR!) canceled/i.test(text)
    : /offline|network connectivity is disabled|not found in the cache|no (?:python )?interpreter found|python downloads are (?:not allowed|disabled)/i.test(text);
}

/** An npm package spec split: `@scope/name@1.2.0` → name and version (or tag); none given: latest. */
export function npmSpec(spec: string): { name: string; version: string } {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) || 'latest' } : { name: spec, version: 'latest' };
}

/**
 * What the registry says about the version npx would fetch: its version and unpacked size (dist.unpackedSize).
 * The package's own size only (what it depends on is not counted); undefined when the registry cannot say (a
 * range such as ^1.2, a private package, no network). `registry`: npm's own setting when the person has one.
 */
export async function npmPackageInfo(spec: string, fetchJson: (url: string) => Promise<unknown>, registry = 'https://registry.npmjs.org'): Promise<{ version: string; bytes?: number } | undefined> {
  const { name, version } = npmSpec(spec);
  if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) || !/^[\w.+-]+$/.test(version)) return undefined;
  try {
    const data = (await fetchJson(`${registry.replace(/\/+$/, '')}/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`)) as { version?: unknown; dist?: { unpackedSize?: unknown } } | undefined;
    if (!data || typeof data.version !== 'string') return undefined;
    const bytes = data.dist?.unpackedSize;
    return { version: data.version, ...(typeof bytes === 'number' && bytes > 0 ? { bytes } : {}) };
  } catch {
    return undefined;
  }
}
