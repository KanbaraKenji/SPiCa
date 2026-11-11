// A picture for the demo backend to hand back as if a plugin tool had made it (a bar chart, no text), written
// into the demo's own folder under the app's data: screenshots need a real image file to show.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

/** A PNG of a few coloured bars on a light background. */
export function barChartPng(width = 480, height = 240): Buffer {
  const bars = [0.55, 0.62, 0.3, 0.45].map((h, i) => ({ x0: 50 + i * 105, x1: 110 + i * 105, top: Math.round(height - 20 - h * (height - 40)) }));
  const colours = [
    [59, 130, 246],
    [16, 185, 129],
    [245, 158, 11],
    [239, 68, 68],
  ];
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      let c = [250, 250, 250];
      bars.forEach((b, i) => {
        if (x >= b.x0 && x < b.x1 && y >= b.top && y < height - 20) c = colours[i]!;
      });
      if (y === height - 20 && x >= 20 && x < width - 20) c = [150, 150, 150];
      raw.set(c, row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** Writes the chart into `dir` (made if missing) and gives its path. */
export function writeDemoChart(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, '报价对比图.png');
  writeFileSync(path, barChartPng());
  return path;
}
