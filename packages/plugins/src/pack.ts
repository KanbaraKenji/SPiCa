// Plugin packages: a zip of the plugin folder with manifest.json at the root
// (the MCPB idea). Node servers ship their node_modules inside the package,
// so the user installs nothing. Checksums are SHA-256 of the zip file.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { hasErrors, readPluginFolder, type PluginFolder } from './folder.ts';
import { MANIFEST_FILE } from './manifest.ts';
import { readZip, safeEntryName, writeZip, type ZipEntry } from './zip.ts';

const SKIP = /(^|\/)(\.git|\.DS_Store|Thumbs\.db)(\/|$)|\.log$/;

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function walk(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    const rel = relative(root, abs).split(sep).join('/');
    if (SKIP.test(rel)) continue;
    if (e.isDirectory()) out.push(...(await walk(root, abs)));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

/** Pack a plugin folder. Refuses folders with manifest errors. */
export async function packPlugin(dir: string, outDir: string): Promise<{ file: string; sha256: string; name: string; version: string; files: number }> {
  const folder = await readPluginFolder(dir);
  if (!folder.manifest || hasErrors(folder.issues)) {
    throw new Error(`插件有问题，不能打包：\n${folder.issues.filter((i) => i.severity === 'error').map((i) => `· ${i.where}：${i.message}`).join('\n')}`);
  }
  const files = await walk(folder.root);
  const entries: ZipEntry[] = [];
  for (const rel of files) entries.push({ name: rel, data: await readFile(join(folder.root, rel)) });
  const buf = writeZip(entries);
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
