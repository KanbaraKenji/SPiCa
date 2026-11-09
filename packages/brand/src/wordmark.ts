/**
 * 字标 SPICA。
 *
 * 现在是几何占位版（64 高、竖笔 12、弧笔描边 11、方头、A 不带横）；字体选定后，
 * 用 scripts/wordmark-from-font.ts 把字体轮廓转成路径替换 WORDMARK，运行时不依赖字体文件。
 * 换字标只改这里。
 */

export interface WordmarkShape {
  d: string;
  /** fill：填充；stroke：按 strokeWidth 描边（方头、尖角） */
  kind: 'fill' | 'stroke';
  strokeWidth?: number;
  evenOdd?: boolean;
}

export interface Wordmark {
  /** 画框宽高（字标自身坐标） */
  width: number;
  height: number;
  shapes: readonly WordmarkShape[];
}

export const WORDMARK: Wordmark = Object.freeze({
  width: 348,
  height: 64,
  shapes: Object.freeze([
    // S
    {
      kind: 'stroke',
      strokeWidth: 11,
      d: 'M50 10C46 6.5 40 5.5 28 5.5C12 5.5 5.5 10 5.5 18.5C5.5 27 12 29.5 28 32C44 34.5 50.5 37 50.5 45.5C50.5 54 44 58.5 28 58.5C16 58.5 9 57 5.5 53.5',
    },
    // P
    {
      kind: 'fill',
      evenOdd: true,
      d: 'M74 0H104C120 0 130 8 130 19S120 38 104 38H86V64H74V0ZM86 10V28H104C112 28 117 25 117 19S112 10 104 10H86Z',
    },
    // I
    { kind: 'fill', d: 'M148 0h12v64h-12z' },
    // C
    {
      kind: 'stroke',
      strokeWidth: 11,
      d: 'M232 13C228 8 221 5.5 210 5.5C193 5.5 183.5 16 183.5 32C183.5 48 193 58.5 210 58.5C221 58.5 228 56 232 51',
    },
    // A
    { kind: 'stroke', strokeWidth: 11, d: 'M262 59 297 5c2-3 4-3 6 0l35 54' },
  ] satisfies WordmarkShape[]),
});
