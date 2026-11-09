/**
 * 把字体里的「Spica」转成路径，重写 src/wordmark.ts。运行时不再依赖字体文件。
 *
 *   npm run wordmark:from-font -w @spica/brand -- <字体.ttf> [字距，千分之一字号，默认 0]
 *
 * 只吃静态字重的 TTF / OTF（可变字体先用 fontTools 的 instancer 取出需要的字重）。
 * 坐标约定：大写字母高 = 64 单位，基线在 y = 64，下伸部分（p 的竖笔）落在 64 以下。
 */
import opentype, { type PathCommand } from 'opentype.js';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT = 'Spica';
const CAP = 64;

const [fontFile, trackingArg = '0'] = process.argv.slice(2);
if (!fontFile) {
  console.error('用法：node scripts/wordmark-from-font.ts <字体.ttf> [字距]');
  process.exit(1);
}

const r = (n: number) => String(Math.round(n * 100) / 100);
function toD(cmds: PathCommand[]): string {
  return cmds
    .map((c) => {
      switch (c.type) {
        case 'M': return `M${r(c.x!)} ${r(c.y!)}`;
        case 'L': return `L${r(c.x!)} ${r(c.y!)}`;
        case 'Q': return `Q${r(c.x1!)} ${r(c.y1!)} ${r(c.x!)} ${r(c.y!)}`;
        case 'C': return `C${r(c.x1!)} ${r(c.y1!)} ${r(c.x2!)} ${r(c.y2!)} ${r(c.x!)} ${r(c.y!)}`;
        default: return 'Z';
      }
    })
    .join('');
}

const buf = readFileSync(fontFile);
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
const capUnits = font.tables.os2?.sCapHeight;
if (!capUnits) throw new Error('字体没有大写高度（OS/2 sCapHeight）');
const size = (CAP * font.unitsPerEm) / capUnits;
const sc = size / font.unitsPerEm;
const tracking = (Number(trackingArg) / 1000) * size;

// 逐字取形（不走 OpenType 替换表，避免连字），加字距对
let x = 0;
let prev: ReturnType<typeof font.charToGlyph> | null = null;
let maxY = CAP;
let minX = Infinity;
let maxX = -Infinity;
const letters: Array<{ d: string; cx: number }> = [];
for (const ch of TEXT) {
  const g = font.charToGlyph(ch);
  if (!g || g.index === 0) throw new Error(`字体缺字：${ch}`);
  if (prev) x += font.getKerningValue(prev, g) * sc;
  const cmds = g.getPath(x, CAP, size).commands;
  for (const c of cmds) {
    for (const [px, py] of [[c.x, c.y], [c.x1, c.y1], [c.x2, c.y2]] as const) {
      if (px === undefined || py === undefined) continue;
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
  }
  const adv = g.advanceWidth * sc;
  letters.push({ d: toD(cmds), cx: x + adv / 2 });
  x += adv + tracking;
  prev = g;
}

// 左边贴齐 0：整体平移
const shift = -minX;
const shiftD = (d: string) => d.replace(/([MLQC])([^MLQCZ]*)/g, (_m, cmd: string, nums: string) => {
  const v = nums.trim().split(/[\s,]+/).map(Number);
  for (let i = 0; i < v.length; i += 2) v[i] = (v[i] ?? 0) + shift;
  return cmd + v.map(r).join(' ');
});
const width = Math.ceil(maxX + shift + 1);
const descent = Math.ceil(maxY - CAP + 1);
const name = font.names.fullName?.en ?? font.names.windows?.fullName?.en ?? path.basename(fontFile);
const version = font.names.version?.en ?? font.names.windows?.version?.en ?? '';

const shapes = letters
  .map((l, i) => `    // ${TEXT[i]}\n    { kind: 'fill', cx: ${r(l.cx + shift)}, d: '${shiftD(l.d)}' },`)
  .join('\n');

const out = `/**
 * 字标 Spica（首字母大写），由 scripts/wordmark-from-font.ts 从字体转成路径生成，不要手改。
 * 字体：${name}${version ? `（${version}）` : ''}
 * 运行时不依赖字体文件。换字标：换字体文件重新跑一遍脚本。
 */

export interface WordmarkShape {
  d: string;
  /** 这个字母的水平中心（字标自身坐标）；开机画面逐字点亮时用 */
  cx: number;
  /** fill：填充；stroke：按 strokeWidth 描边（方头、尖角） */
  kind: 'fill' | 'stroke';
  strokeWidth?: number;
  evenOdd?: boolean;
}

export interface Wordmark {
  /** 画框宽（字标自身坐标） */
  width: number;
  /** 大写字母高（= 基线的 y）；每个 shape 是一个字母，按书写顺序排 */
  height: number;
  /** 基线以下的下伸深度（p 的竖笔） */
  descent: number;
  shapes: readonly WordmarkShape[];
}

export const WORDMARK: Wordmark = Object.freeze({
  width: ${width},
  height: ${CAP},
  descent: ${descent},
  shapes: Object.freeze([
${shapes}
  ] satisfies WordmarkShape[]),
});
`;

const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/wordmark.ts');
writeFileSync(target, out);
console.log(`已写入 ${path.relative(process.cwd(), target)}：${name}，宽 ${width}，下伸 ${descent}`);
