/**
 * PNG-in-ICO 打包：把若干张 PNG 原样装进一个 .ico（Windows Vista 起都认 PNG 条目）。
 */

export interface IcoEntry {
  /** 边长（1–256） */
  size: number;
  png: Uint8Array;
}

export function buildIco(entries: readonly IcoEntry[]): Uint8Array {
  const count = entries.length;
  const headerSize = 6 + 16 * count;
  const total = headerSize + entries.reduce((n, e) => n + e.png.length, 0);
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  view.setUint16(0, 0, true); // 保留
  view.setUint16(2, 1, true); // 类型：图标
  view.setUint16(4, count, true);
  let offset = headerSize;
  entries.forEach((e, i) => {
    if (e.size < 1 || e.size > 256) throw new Error(`ICO 尺寸超出 1–256：${e.size}`);
    const dir = 6 + 16 * i;
    view.setUint8(dir, e.size === 256 ? 0 : e.size); // 宽（0 表示 256）
    view.setUint8(dir + 1, e.size === 256 ? 0 : e.size); // 高
    view.setUint8(dir + 2, 0); // 调色板颜色数
    view.setUint8(dir + 3, 0); // 保留
    view.setUint16(dir + 4, 1, true); // 色平面
    view.setUint16(dir + 6, 32, true); // 位深
    view.setUint32(dir + 8, e.png.length, true);
    view.setUint32(dir + 12, offset, true);
    buf.set(e.png, offset);
    offset += e.png.length;
  });
  return buf;
}
