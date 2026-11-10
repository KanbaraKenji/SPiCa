/**
 * 把一段文字按字体转成字标路径（Wordmark）。打包脚本和 wordmark-from-font.ts 共用。
 *
 * 坐标约定：大写字母高 = 64 单位，基线在 y = 64；下伸部分（p 的竖笔）落在 64 以下，
 * 高过大写字母的部分（d、l 的竖笔，重音符号）落在 0 以上，记在 ascent 里。
 * 每个字母一个 shape（开机画面逐字点亮）；空格只占位置，不出 shape。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import opentype, { type Font, type Glyph, type PathCommand } from 'opentype.js';
import { WORDMARK, type Wordmark, type WordmarkShape } from '../src/wordmark.ts';

/** 仓库自带的字标字体（Gelasio Bold，SIL OFL 1.1） */
export const BUNDLED_WORDMARK_FONT = fileURLToPath(new URL('../../../branding/fonts/Gelasio-Bold.ttf', import.meta.url));

/**
 * 构建时用：按应用名生成字标，交给 SpicaSplash / SpicaBanner 的 wordmark 属性。
 * 不给字体就用仓库自带的 Gelasio；名字是 Spica 且没给字体时，原样返回仓库里的 WORDMARK。
 * 字体里缺字、文字为空时抛错，消息是给人看的中文。
 */
export function wordmarkForName(name: string, font?: Uint8Array): Wordmark {
  if (!font && name.trim() === 'Spica') return WORDMARK;
  return wordmarkFromFont(font ?? readFileSync(BUNDLED_WORDMARK_FONT), name).wordmark;
}

export const WORDMARK_CAP = 64;

export interface FontWordmark {
  wordmark: Wordmark;
  /** 每个 shape 对应的字母（写注释用） */
  chars: string[];
  fontName: string;
  fontVersion: string;
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

/** 字体里大写字母的高度（字体单位）：优先读 OS/2 表，没有就量 H 的外框 */
function capHeightUnits(font: Font): number {
  const fromTable = font.tables.os2?.sCapHeight;
  if (fromTable) return fromTable;
  const h = font.charToGlyph('H');
  if (h && h.index !== 0) {
    const box = h.getBoundingBox();
    if (box.y2 > 0) return box.y2;
  }
  throw new Error('这个字体量不出大写字母的高度（没有 OS/2 的 sCapHeight，也没有字母 H），换一个字体文件');
}

/**
 * @param fontBytes 静态字重的 TTF / OTF（可变字体先取出需要的字重）
 * @param text 字标文字，原样使用（大小写不改）
 * @param tracking 字距，千分之一字号
 */
export function wordmarkFromFont(fontBytes: Uint8Array, text: string, tracking = 0): FontWordmark {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('字标文字是空的');
  const buf = fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength) as ArrayBuffer;
  const font = opentype.parse(buf);

  const missing = [...new Set([...trimmed].filter((ch) => !/\s/.test(ch) && font.charToGlyph(ch)?.index === 0))];
  if (missing.length) {
    throw new Error(`字体里没有这些字：${missing.join(' ')}。换一个包含它们的字体文件，或者改字标文字`);
  }

  const size = (WORDMARK_CAP * font.unitsPerEm) / capHeightUnits(font);
  const sc = size / font.unitsPerEm;
  const track = (tracking / 1000) * size;

  // 逐字取形（不走 OpenType 替换表，避免连字），加字距对
  let x = 0;
  let prev: Glyph | null = null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = 0;
  let maxY = WORDMARK_CAP;
  const letters: Array<{ cmds: PathCommand[]; cx: number; ch: string }> = [];
  for (const ch of trimmed) {
    const g = font.charToGlyph(ch);
    if (prev) x += font.getKerningValue(prev, g) * sc;
    const adv = g.advanceWidth * sc;
    const cmds = /\s/.test(ch) ? [] : g.getPath(x, WORDMARK_CAP, size).commands;
    for (const c of cmds) {
      for (const [px, py] of [[c.x, c.y], [c.x1, c.y1], [c.x2, c.y2]] as const) {
        if (px === undefined || py === undefined) continue;
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
      }
    }
    if (cmds.length) letters.push({ cmds, cx: x + adv / 2, ch });
    x += adv + track;
    prev = g;
  }
  if (!letters.length) throw new Error('字标文字里没有能画出来的字');

  // 左边贴齐 0：整体平移
  const shift = -minX;
  const shiftD = (d: string) =>
    d.replace(/([MLQC])([^MLQCZ]*)/g, (_m, cmd: string, nums: string) => {
      const v = nums.trim().split(/[\s,]+/).map(Number);
      for (let i = 0; i < v.length; i += 2) v[i] = (v[i] ?? 0) + shift;
      return cmd + v.map(r).join(' ');
    });

  const ascent = minY < 0 ? Math.ceil(-minY + 1) : 0;
  const shapes: WordmarkShape[] = letters.map((l) => ({ kind: 'fill', cx: Number(r(l.cx + shift)), d: shiftD(toD(l.cmds)) }));
  const wordmark: Wordmark = {
    text: trimmed,
    width: Math.ceil(maxX + shift + 1),
    height: WORDMARK_CAP,
    descent: Math.ceil(maxY - WORDMARK_CAP + 1),
    ...(ascent ? { ascent } : {}),
    shapes,
  };
  return {
    wordmark,
    chars: letters.map((l) => l.ch),
    fontName: font.names.fullName?.en ?? font.names.windows?.fullName?.en ?? '',
    fontVersion: font.names.version?.en ?? font.names.windows?.version?.en ?? '',
  };
}

/** 生成 src/wordmark.ts 的源码（仓库自带的 Spica 字标走这条） */
export function wordmarkModuleSource(fw: FontWordmark, text: string): string {
  const wm = fw.wordmark;
  const shapes = wm.shapes
    .map((s, i) => `    // ${fw.chars[i]}\n    { kind: 'fill', cx: ${r(s.cx)}, d: '${s.d}' },`)
    .join('\n');
  return `/**
 * 字标 ${text}，由 scripts/wordmark-from-font.ts 从字体转成路径生成，不要手改。
 * 字体：${fw.fontName}${fw.fontVersion ? `（${fw.fontVersion}）` : ''}
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
  /** 高过大写字母的部分（d、l 的竖笔、重音符号），画在 y = 0 以上；没有就不写 */
  ascent?: number;
  /** 字标的文字（无障碍名称用）；仓库自带的 Spica 不写，缺省就是 Spica */
  text?: string;
  shapes: readonly WordmarkShape[];
}

export const WORDMARK: Wordmark = Object.freeze({
  width: ${wm.width},
  height: ${wm.height},
  descent: ${wm.descent},
${wm.ascent ? `  ascent: ${wm.ascent},\n` : ''}  shapes: Object.freeze([
${shapes}
  ] satisfies WordmarkShape[]),
});
`;
}
