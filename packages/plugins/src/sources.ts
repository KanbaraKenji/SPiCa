// Where plugins come from: a shared-drive folder or an HTTP server.
//
// Both use the same index file (index.json) listing packages with version and
// SHA-256. A shared folder without index.json is scanned instead: every
// sub-folder with a manifest.json and every *.zip counts. HTTP sources must
// have an index and every entry must carry a checksum.
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hasErrors, readPluginFolder } from './folder.ts';
import { compareVersions, satisfies, stripBom } from './manifest.ts';
import type { InstallStep, PluginDescription, PluginManager, PluginSource } from './manager.ts';
import { sha256, unpackPlugin, verifyPackage } from './pack.ts';

export const INDEX_FILE = 'index.json';

export interface SourceConfig {
  kind: 'share' | 'http';
  /** Folder path (share) or the URL of index.json (http). */
  location: string;
  /** Shown in the shell, e.g. "Team share". */
  label?: string;
}

export interface IndexEntry {
  name: string;
  version: string;
  /** Package file relative to the index, or an absolute URL. Folders end with '/'. */
  file: string;
  sha256?: string;
  /** Compatible Spica range, copied from the manifest so it can be checked before download. */
  spica?: string;
  description?: string;
}

export interface IndexFile {
  index_version: 1;
  plugins: IndexEntry[];
}

export interface Available extends IndexEntry {
  source: SourceConfig;
  /** Resolved path or URL of the package. */
  location: string;
  form: 'zip' | 'folder';
}

export interface UpdateInfo {
  name: string;
  installed: string;
  available: string;
  entry: Available;
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  /** Present on a real fetch Response: read in pieces so a download can say how far it is. */
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> } } | null;
  headers?: { get(name: string): string | null };
}>;

export interface SourceOptions {
  /** Defaults to global fetch. In the desktop app pass Electron's net.fetch so system proxy settings apply. */
  fetch?: FetchLike;
  timeoutMs?: number;
  spicaVersion?: string;
  /** App name in user-facing messages. Default 'Spica'. */
  appName?: string;
  /** Installing: each step as it is reached, the download with its bytes (a few times a second at most). */
  onProgress?: (p: InstallStep) => void;
}

/** A download fails when no data has come for this long (not when it is merely slow). */
export const DOWNLOAD_IDLE_MS = 60_000;
/** How often a download says how far it is, at most. */
const PROGRESS_EVERY_MS = 250;

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function getText(url: string, opts: SourceOptions): Promise<string> {
  const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const res = await f(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Download a package. It fails only when nothing has arrived for `timeoutMs`
 * (DOWNLOAD_IDLE_MS by default), so a big package on a slow line still comes
 * through; on the way it says how many bytes it has, and the total when the
 * server gives one.
 */
export async function downloadPackage(url: string, opts: SourceOptions = {}): Promise<Buffer> {
  const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const idleMs = opts.timeoutMs ?? DOWNLOAD_IDLE_MS;
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stillAlive = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => stop.abort(new Error(`${Math.round(idleMs / 1000)} 秒没有收到数据`)), idleMs);
  };
  stillAlive();
  try {
    const res = await f(url, { signal: stop.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const length = Number(res.headers?.get('content-length') ?? NaN);
    const total = Number.isFinite(length) && length > 0 ? length : undefined;
    const say = (received: number) => opts.onProgress?.({ step: 'download', received, ...(total ? { total } : {}) });
    const reader = res.body?.getReader();
    if (!reader) {
      say(0);
      const buf = Buffer.from(await res.arrayBuffer());
      say(buf.length);
      return buf;
    }
    const parts: Uint8Array[] = [];
    let received = 0;
    let said = 0;
    say(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      stillAlive();
      parts.push(value);
      received += value.length;
      if (Date.now() - said >= PROGRESS_EVERY_MS) {
        said = Date.now();
        say(received);
      }
    }
    say(received);
    return Buffer.concat(parts);
  } catch (err) {
    throw stop.signal.aborted && stop.signal.reason instanceof Error ? stop.signal.reason : err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseIndex(text: string, where: string): IndexFile {
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch {
    throw new Error(`${where} 不是有效的 JSON。`);
  }
  const idx = raw as Partial<IndexFile>;
  if (idx.index_version !== 1 || !Array.isArray(idx.plugins)) throw new Error(`${where} 格式无效，须为 { "index_version": 1, "plugins": [ … ] }。`);
  for (const p of idx.plugins) {
    if (typeof p?.name !== 'string' || typeof p.version !== 'string' || typeof p.file !== 'string') {
      throw new Error(`${where} 中有一条缺少 name / version / file。`);
    }
  }
  return idx as IndexFile;
}

/** List what a source offers. Throws with a plain message if the source cannot be read. */
export async function listSource(src: SourceConfig, opts: SourceOptions = {}): Promise<Available[]> {
  if (src.kind === 'http') {
    let text: string;
    try {
      text = await getText(src.location, opts);
    } catch (err) {
      throw new Error(`无法连接插件源 ${src.label ?? src.location}（${(err as Error).message}）。`, { cause: err });
    }
    const idx = parseIndex(text, src.location);
    return idx.plugins.map((p) => ({ ...p, source: src, location: new URL(p.file, src.location).href, form: 'zip' as const }));
  }
  const root = resolve(src.location);
  if (!(await isDir(root))) throw new Error(`找不到共享文件夹 ${src.location}，请检查网络驱动器是否已连接。`);
  try {
    const idx = parseIndex(await readFile(join(root, INDEX_FILE), 'utf8'), join(root, INDEX_FILE));
    return idx.plugins.map((p) => ({
      ...p,
      source: src,
      location: resolve(root, p.file),
      form: p.file.endsWith('/') ? ('folder' as const) : ('zip' as const),
    }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // No index: scan folders and zips.
  const out: Available[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    const abs = join(root, e.name);
    if (e.isDirectory()) {
      const f = await readPluginFolder(abs, opts);
      if (f.manifest) out.push({ name: f.manifest.name, version: f.manifest.version, file: `${e.name}/`, spica: f.manifest.spica, description: f.manifest.description, source: src, location: abs, form: 'folder' });
    } else if (e.isFile() && e.name.endsWith('.zip')) {
      const buf = await readFile(abs);
      const v = await verifyPackage(buf, undefined, opts).catch(() => undefined);
      const m = v?.folder.manifest;
      if (m) out.push({ name: m.name, version: m.version, file: e.name, sha256: v.sha256, spica: m.spica, description: m.description, source: src, location: abs, form: 'zip' });
    }
  }
  return out;
}

/** Newest compatible version per plugin across sources. */
export function newest(entries: Available[], spicaVersion: string): Map<string, Available> {
  const best = new Map<string, Available>();
  for (const e of entries) {
    if (e.spica && !satisfies(spicaVersion, e.spica)) continue;
    const cur = best.get(e.name);
    if (!cur || compareVersions(e.version, cur.version) > 0) best.set(e.name, e);
  }
  return best;
}

/** Installed plugins that have a newer compatible version in the sources. Unreadable sources are reported, not fatal. */
export async function checkUpdates(
  manager: PluginManager,
  sources: SourceConfig[],
  opts: SourceOptions = {},
): Promise<{ updates: UpdateInfo[]; errors: { source: SourceConfig; message: string }[] }> {
  const all: Available[] = [];
  const errors: { source: SourceConfig; message: string }[] = [];
  for (const s of sources) {
    try {
      all.push(...(await listSource(s, opts)));
    } catch (err) {
      errors.push({ source: s, message: (err as Error).message });
    }
  }
  const updates: UpdateInfo[] = [];
  for (const [name, entry] of newest(all, opts.spicaVersion ?? '0.1.0')) {
    const installed = manager.installedVersion(name);
    if (installed && compareVersions(entry.version, installed) > 0) updates.push({ name, installed, available: entry.version, entry });
  }
  return { updates, errors };
}

/** Download (if needed), verify and install one entry; `onProgress` hears every step. */
export async function installAvailable(manager: PluginManager, entry: Available, opts: SourceOptions = {}): Promise<PluginDescription> {
  const source: PluginSource = { kind: entry.source.kind, location: entry.location };
  const install = opts.onProgress ? { onProgress: opts.onProgress } : {};
  if (entry.form === 'folder') return manager.install(entry.location, source, install);
  if (entry.source.kind === 'http' && !entry.sha256) throw new Error(`插件源中「${entry.name}」缺少校验和（sha256），未安装。`);
  let buf: Buffer;
  try {
    if (entry.source.kind === 'http') buf = await downloadPackage(entry.location, opts);
    else {
      opts.onProgress?.({ step: 'read' });
      buf = await readFile(entry.location);
    }
  } catch (err) {
    throw new Error(`下载「${entry.name}」${entry.version} 失败（${(err as Error).message}）。`, { cause: err });
  }
  if (entry.sha256) {
    opts.onProgress?.({ step: 'verify' });
    if (sha256(buf) !== entry.sha256.toLowerCase()) throw new Error(`「${entry.name}」${entry.version} 校验和不匹配，文件可能已损坏或被替换，未安装。`);
  }
  return installZip(manager, buf, source, install);
}

/** Install from zip bytes (a package the user picked, or a download). */
export async function installZip(manager: PluginManager, buf: Buffer, source: PluginSource, opts: { onProgress?: (p: InstallStep) => void } = {}): Promise<PluginDescription> {
  const tmp = await mkdtemp(join(tmpdir(), 'spica-plugin-'));
  try {
    opts.onProgress?.({ step: 'unpack' });
    const folder = await unpackPlugin(buf, tmp, { appName: manager.appName });
    if (!folder.manifest || hasErrors(folder.issues)) {
      throw new Error(`插件包有错误：\n${folder.issues.filter((i) => i.severity === 'error').map((i) => `· ${i.where}：${i.message}`).join('\n')}`);
    }
    return await manager.install(tmp, source, opts.onProgress ? { onProgress: opts.onProgress } : {});
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Write index.json for a folder of packages (for whoever publishes plugins to a share or web server). */
export async function writeIndex(dir: string): Promise<IndexFile> {
  const plugins: IndexEntry[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.zip')) continue;
    const buf = await readFile(join(dir, e.name));
    const v = await verifyPackage(buf);
    const m = v.folder.manifest;
    if (!m || !v.ok) continue;
    plugins.push({ name: m.name, version: m.version, file: e.name, sha256: v.sha256, spica: m.spica, description: m.description });
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name) || compareVersions(a.version, b.version));
  const idx: IndexFile = { index_version: 1, plugins };
  await writeFile(join(dir, INDEX_FILE), `${JSON.stringify(idx, null, 2)}\n`);
  return idx;
}
