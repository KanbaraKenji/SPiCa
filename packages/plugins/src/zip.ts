// Minimal zip reader and writer (stored + deflate, no zip64, no encryption),
// enough for plugin packages. Uses only node:zlib, so the host needs nothing
// extra. Entry names are checked so a package can never write outside the
// folder it is unpacked into.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Forward-slash relative path; folders end with '/'. */
  name: string;
  data: Buffer;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

/** A safe relative entry name, or undefined if it could escape the target folder. */
export function safeEntryName(name: string): string | undefined {
  const n = name.replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.includes('\0')) return undefined;
  const parts = n.split('/');
  if (parts.some((p) => p === '..' || p === '.')) return undefined;
  return n;
}

export function writeZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // Fixed timestamp keeps packages reproducible (same files → same checksum).
  const dosTime = 0;
  const dosDate = (1 << 5) | 1; // 1980-01-01
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const isDir = e.name.endsWith('/');
    const deflated = isDir ? Buffer.alloc(0) : deflateRawSync(e.data);
    const useDeflate = !isDir && deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(CENTRAL, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(useDeflate ? 8 : 0, 10);
    c.writeUInt16LE(dosTime, 12);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(isDir ? 0x10 : 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

/** Read every entry. Throws ZipError with a plain message on damaged or unsafe archives. */
export function readZip(buf: Buffer, limits: { maxEntries?: number; maxBytes?: number } = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 5000;
  const maxBytes = limits.maxBytes ?? 512 * 1024 * 1024;
  let endAt = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === END) {
      endAt = i;
      break;
    }
  }
  if (endAt < 0) throw new ZipError('不是 zip 文件，或者文件不完整（下载没下完？）。');
  const count = buf.readUInt16LE(endAt + 10);
  const cdOffset = buf.readUInt32LE(endAt + 16);
  if (count > maxEntries) throw new ZipError(`压缩包里文件太多（${count} 个）。`);
  const out: ZipEntry[] = [];
  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new ZipError('压缩包目录损坏。');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    const name = safeEntryName(rawName);
    if (!name) throw new ZipError(`压缩包里有不安全的路径「${rawName}」，拒绝解开。`);
    total += usize;
    if (total > maxBytes) throw new ZipError('压缩包解开后太大。');
    if (buf.readUInt32LE(lho) !== LOCAL) throw new ZipError('压缩包文件头损坏。');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const body = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = inflateRawSync(body, { maxOutputLength: Math.max(usize, 1) });
    else throw new ZipError(`压缩包用了不支持的压缩方式（${method}），请用普通 zip 重新打包。`);
    if (data.length !== usize || (crc32(data) >>> 0) !== crc) throw new ZipError(`压缩包里的「${name}」校验失败，文件可能损坏。`);
    out.push({ name, data });
  }
  return out;
}
