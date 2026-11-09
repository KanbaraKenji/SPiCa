// opentype.js 2.0 没有自带类型；这里只声明 wordmark-from-font.ts 用到的部分。
declare module 'opentype.js' {
  export interface PathCommand {
    type: 'M' | 'L' | 'Q' | 'C' | 'Z';
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }
  export interface Glyph {
    index: number;
    advanceWidth: number;
    getPath(x: number, y: number, fontSize: number): { commands: PathCommand[] };
  }
  export interface Font {
    unitsPerEm: number;
    names: {
      fullName?: Record<string, string>;
      version?: Record<string, string>;
      windows?: { fullName?: Record<string, string>; version?: Record<string, string> };
    };
    tables: { os2?: { sCapHeight?: number } };
    charToGlyph(ch: string): Glyph;
    getKerningValue(left: Glyph, right: Glyph): number;
  }
  export function parse(buffer: ArrayBuffer): Font;
  const opentype: { parse: typeof parse };
  export default opentype;
}
