import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MARK_VIEWBOX } from '../src/geometry.ts';
import { SPLASH_LAYOUT, SPLASH_STAGE, splashFrame, splashLayout } from '../src/splash.ts';
import { BANNER_LAYOUT, bannerLayout, bannerSvg, wordmarkSvg } from '../src/svg.ts';
import { WORDMARK } from '../src/wordmark.ts';
import { wordmarkForName, wordmarkFromFont, wordmarkModuleSource } from './wordmark-font.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FONT = readFileSync(path.join(here, '../../../branding/fonts/Gelasio-Bold.ttf'));
const make = (text: string) => wordmarkFromFont(FONT, text).wordmark;

// 只用明显是假名字的字样；仓库里不出现任何真实的公司名
const NAMES = ['AB', 'Abcd', 'Hello World', 'ABCDEFGHIJKLMNOP', 'Élan'];

describe('按字体生成字标', () => {
  it('仓库自带的 Spica：用自带字体重新生成，和 src/wordmark.ts 一个字节不差', () => {
    const committed = readFileSync(path.join(here, '../src/wordmark.ts'), 'utf8');
    expect(wordmarkModuleSource(wordmarkFromFont(FONT, 'Spica'), 'Spica')).toBe(committed);
  });

  it('空格只占位置，不算一个字母', () => {
    const wm = make('Hello World');
    expect(wm.shapes).toHaveLength(10);
    expect(wm.text).toBe('Hello World');
    const cx = wm.shapes.map((s) => s.cx);
    expect([...cx].sort((a, b) => a - b)).toEqual(cx);
    // o 和 W 之间隔着一个空格的宽度，比相邻字母的间隔大
    expect(cx[5]! - cx[4]!).toBeGreaterThan(1.5 * (cx[4]! - cx[3]!));
  });

  it('高过大写字母的笔画记在 ascent 里，下伸记在 descent 里', () => {
    expect(make('Abcd').ascent).toBeGreaterThan(0); // b、d 的竖笔
    expect(make('Élan').ascent).toBeGreaterThan(make('Abcd').ascent!); // 重音符号更高
    expect(make('AB').descent).toBeLessThan(WORDMARK.descent); // 没有 p 的竖笔
  });

  it('构建时的 wordmarkForName：缺省用自带字体，Spica 原样返回仓库里的字标', () => {
    expect(wordmarkForName('Spica')).toBe(WORDMARK);
    expect(wordmarkForName('Abcd')).toEqual(make('Abcd'));
    expect(wordmarkForName('Abcd', FONT)).toEqual(make('Abcd'));
    expect(() => wordmarkForName('A测B')).toThrow('字体里没有这些字：测');
  });

  it('字体里缺的字一次全列出来', () => {
    expect(() => make('A测试B')).toThrow('字体里没有这些字：测 试');
    expect(() => make('   ')).toThrow('字标文字是空的');
  });
});

describe('任意字样的版面', () => {
  const markW = MARK_VIEWBOX * (SPLASH_STAGE.height * 0.36) / MARK_VIEWBOX;

  it('Spica 的开机画面版面和改动前一样', () => {
    expect(splashLayout()).toBe(SPLASH_LAYOUT);
    expect(SPLASH_LAYOUT.wordScale).toBe(1.5);
    expect(SPLASH_LAYOUT.wordY).toBe(SPLASH_STAGE.height / 2 + 6 - 48);
    expect(SPLASH_LAYOUT.cx).toBeCloseTo((SPLASH_STAGE.width - (markW + 40 + 252 * 1.5)) / 2 + markW / 2, 6);
    expect(bannerLayout()).toEqual(BANNER_LAYOUT);
    expect(BANNER_LAYOUT.top).toBe(0);
  });

  it.each(NAMES)('「%s」：花标加字标整组居中，放得进舞台，字不出上下边', (name) => {
    const wm = make(name);
    const L = splashLayout(wm);
    const left = L.cx - markW / 2;
    const right = L.wordX + wm.width * L.wordScale;
    expect(left).toBeGreaterThanOrEqual(SPLASH_STAGE.width * 0.1 - 1e-6);
    expect(right).toBeLessThanOrEqual(SPLASH_STAGE.width * 0.9 + 1e-6);
    expect(left + right).toBeCloseTo(SPLASH_STAGE.width, 6);
    // 大写字母竖向居中在花心上，字不超出舞台
    expect(L.wordY + (wm.height * L.wordScale) / 2).toBeCloseTo(L.cy, 6);
    expect(L.wordY - (wm.ascent ?? 0) * L.wordScale).toBeGreaterThan(0);
    expect(L.wordY + (wm.height + wm.descent) * L.wordScale).toBeLessThan(SPLASH_STAGE.height);
    // 短名字不放大，长名字才缩小
    expect(L.wordScale).toBeLessThanOrEqual(1.5);
  });

  it.each(NAMES)('「%s」：开机画面每个字母一组状态，双星绕着挪过去的花心转', (name) => {
    const wm = make(name);
    const L = splashLayout(wm);
    const dx = L.cx - SPLASH_LAYOUT.cx;
    for (const t of [0.5, 2, 4.2, 7.3, 8.1]) {
      const own = splashFrame(t, 7, { wordmark: wm });
      const base = splashFrame(t, 7);
      expect(own.letters).toHaveLength(wm.shapes.length);
      expect(own.stars.length).toBe(base.stars.length);
      own.stars.forEach((s, i) => {
        expect(s.x).toBeCloseTo(base.stars[i]!.x + dx, 6);
        expect(s.y).toBeCloseTo(base.stars[i]!.y, 6);
      });
    }
    // 扫字的光从字标左边扫到右边以外，每个字母都会亮满
    const end = splashFrame(11, 7, { wordmark: wm });
    for (const l of end.letters) expect(l.opacity).toBeCloseTo(1, 3);
  });

  it.each(NAMES)('「%s」：横标和字标的画框包住所有笔画', (name) => {
    const wm = make(name);
    const L = bannerLayout(wm);
    const scale = 36 / wm.height;
    const wordY = (MARK_VIEWBOX - 36) / 2;
    expect(L.top).toBeLessThanOrEqual(wordY - (wm.ascent ?? 0) * scale);
    expect(L.top + L.height).toBeGreaterThanOrEqual(wordY + (wm.height + wm.descent) * scale);
    expect(L.top + L.height).toBeGreaterThanOrEqual(MARK_VIEWBOX);
    expect(bannerSvg({ wordmark: wm })).toContain(`viewBox="0 ${L.top} `);
    const asc = wm.ascent ?? 0;
    expect(wordmarkSvg({ wordmark: wm })).toContain(`viewBox="0 ${-asc} ${wm.width} ${asc + wm.height + wm.descent}"`);
  });
});
