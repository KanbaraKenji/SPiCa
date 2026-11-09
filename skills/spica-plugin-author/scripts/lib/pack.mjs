// Packing for plugin authors: a zip of the plugin folder with manifest.json at
// the root, same layout and rules as Spica's own packer (packages/plugins),
// but with no dependencies so this skill works on a machine without the Spica
// source. Spica checks the package again when it installs it.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

export const IGNORE_FILE = '.spicaignore';
const SKIP = /(^|\/)(\.git|\.DS_Store|Thumbs\.db)(\/|$)|\.log$/;
const GLOB = { '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' };

export const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** .gitignore subset: `*` `**` `?`, trailing `/` = folders only, a slash anchors to the root, no `!`. */
export function parseIgnore(text) {
  const rules = [];
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
      .map((p) => GLOB[p] ?? p.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      .join('');
    rules.push({ re: new RegExp(`${anchored ? '^' : '(^|/)'}${body}$`), dirOnly });
  }
  return rules;
}

/** Files that go into the package (forward-slash relative paths, sorted). */
export async function packageFiles(root) {
  const rules = await readFile(join(root, IGNORE_FILE), 'utf8').then(parseIgnore, () => []);
  const out = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (SKIP.test(rel) || rel === IGNORE_FILE) continue;
      if (rel !== 'manifest.json' && rules.some((r) => (e.isDirectory() || !r.dirOnly) && r.re.test(rel))) continue;
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.push(rel);
    }
  };
  await walk(root);
  return out.sort();
}

/** Zip with a fixed timestamp (same files → same checksum), deflate when it helps. */
export function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosDate = (1 << 5) | 1; // 1980-01-01
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const deflated = deflateRawSync(e.data);
    const deflate = deflated.length < e.data.length;
    const body = deflate ? deflated : e.data;
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
