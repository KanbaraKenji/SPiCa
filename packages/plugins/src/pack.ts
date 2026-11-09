// Plugin packages: a zip of the plugin folder with manifest.json at the root
// (the MCPB idea). Node servers ship their node_modules inside the package,
// so the user installs nothing. Checksums are SHA-256 of the zip file.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { hasErrors, readPluginFolder, type PluginFolder } from './folder.ts';
import { MANIFEST_FILE, stripBom } from './manifest.ts';
import { readZip, safeEntryName, writeZip, type ZipEntry } from './zip.ts';

const SKIP = /(^|\/)(\.git|\.DS_Store|Thumbs\.db)(\/|$)|\.log$/;

/** File in the plugin root listing what to leave out of the package (like .mcpbignore). */
export const IGNORE_FILE = '.spicaignore';

interface IgnoreRule {
  re: RegExp;
  dirOnly: boolean;
}

const GLOB_TOKENS: Record<string, string> = { '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' };

/**
 * A small subset of .gitignore: one pattern per line, `#` comments,
 * `*` / `**` / `?`, a trailing `/` for folders only; a pattern containing a
 * slash is relative to the plugin root, one without matches a name at any
 * depth. No `!` negation.
 */
export function parseIgnore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of stripBom(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const dirOnly = line.endsWith('/');
    line = line.replace(/\/+$/, '');
    const anchored = line.includes('/');
    line = line.replace(/^\/+/, '');
    if (!line) continue;
    const body = line
      .split(/(\*\*\/?|\*|\?)/)
      .map((part) => GLOB_TOKENS[part] ?? part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      .join('');
    rules.push({ re: new RegExp(`${anchored ? '^' : '(^|/)'}${body}$`), dirOnly });
  }
  return rules;
}

function ignored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  if (rel === MANIFEST_FILE) return false;
  return rules.some((r) => (isDir || !r.dirOnly) && r.re.test(rel));
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function walk(root: string, rules: IgnoreRule[], dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    const rel = relative(root, abs).split(sep).join('/');
    if (SKIP.test(rel) || rel === IGNORE_FILE || ignored(rules, rel, e.isDirectory())) continue;
    if (e.isDirectory()) out.push(...(await walk(root, rules, abs)));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * Pack a plugin folder, leaving out what .spicaignore lists. Refuses folders
 * with manifest errors, and packages that would no longer load (for example
 * when an ignore rule drops a server entry).
 */
export async function packPlugin(dir: string, outDir: string): Promise<{ file: string; sha256: string; name: string; version: string; files: number }> {
  const folder = await readPluginFolder(dir);
  if (!folder.manifest || hasErrors(folder.issues)) {
    throw new Error(`插件有问题，不能打包：\n${folder.issues.filter((i) => i.severity === 'error').map((i) => `· ${i.where}：${i.message}`).join('\n')}`);
  }
  const rules = await readFile(join(folder.root, IGNORE_FILE), 'utf8').then(parseIgnore, () => []);
  const files = await walk(folder.root, rules);
  const entries: ZipEntry[] = [];
  for (const rel of files) entries.push({ name: rel, data: await readFile(join(folder.root, rel)) });
  const buf = writeZip(entries);
  const check = await verifyPackage(buf);
  if (!check.ok) {
    throw new Error(`打出来的包装不上，没有写出（多半是 ${IGNORE_FILE} 排除了要用的文件）：\n${check.folder.issues.filter((i) => i.severity === 'error').map((i) => `· ${i.where}：${i.message}`).join('\n')}`);
  }
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `${folder.manifest.name}-${folder.manifest.version}.zip`);
  await writeFile(file, buf);
  return { file, sha256: sha256(buf), name: folder.manifest.name, version: folder.manifest.version, files: entries.length };
}

/**
 * Unpack a package into `target` (which must not exist yet or be empty).
 * Accepts manifest.json at the root, or inside a single top folder (what
 * Windows "Send to → Compressed folder" produces).
 */
export async function unpackPlugin(zip: Buffer, target: string): Promise<PluginFolder> {
  const entries = readZip(zip).filter((e) => !e.name.endsWith('/'));
  let prefix = '';
  if (!entries.some((e) => e.name === MANIFEST_FILE)) {
    const tops = new Set(entries.map((e) => e.name.split('/')[0]));
    const only = [...tops][0];
    if (tops.size === 1 && only && entries.some((e) => e.name === `${only}/${MANIFEST_FILE}`)) prefix = `${only}/`;
    else throw new Error(`压缩包里没有 ${MANIFEST_FILE}，不是 Spica 插件包。`);
  }
  await mkdir(target, { recursive: true });
  for (const e of entries) {
    if (!e.name.startsWith(prefix)) continue;
    const rel = safeEntryName(e.name.slice(prefix.length));
    if (!rel) continue;
    const abs = join(target, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, e.data);
  }
  return readPluginFolder(target);
}

/** Check a package without installing it: unpack to a temp folder and validate. */
export async function verifyPackage(zip: Buffer, expectedSha256?: string): Promise<{ folder: PluginFolder; sha256: string; ok: boolean }> {
  const sum = sha256(zip);
  const tmp = await mkdtemp(join(tmpdir(), 'spica-verify-'));
  try {
    if (expectedSha256 && expectedSha256.toLowerCase() !== sum) {
      return {
        folder: { root: tmp, skills: [], commands: [], servers: [], hooks: [], views: [], issues: [{ where: '校验和', severity: 'error', message: '下载的文件和来源公布的校验和对不上，可能损坏或被替换，没有安装。' }] },
        sha256: sum,
        ok: false,
      };
    }
    const folder = await unpackPlugin(zip, tmp);
    return { folder: { ...folder }, sha256: sum, ok: !!folder.manifest && !hasErrors(folder.issues) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
