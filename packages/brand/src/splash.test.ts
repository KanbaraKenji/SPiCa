import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { SPLASH_FINISH_AFTER, SPLASH_LAYOUT, SPLASH_TIMING, STARFIELD_COUNT, STARFIELD_MAX_SPEED, splashFrame, splashStaticFrame, starfield } from './splash.ts';
import { MARK_GEOMETRY } from './geometry.ts';
import { SpicaSplash } from './react/SpicaSplash.tsx';

describe('开机画面时间线', () => {
  it('没 ready 就一直循环，不会结束', () => {
    for (const t of [0, 1, 5, 60, 600]) {
      const f = splashFrame(t, null);
      expect(f.finished).toBe(false);
      expect(f.layer).toBe(1);
      expect(f.stars).toHaveLength(2); // 一蓝一白两颗
    }
  });

  it('双星相对 180°、在同一轨道上，中点就是花心', () => {
    for (const t of [0.4, 1.3, 2.2]) {
      const [a, b] = splashFrame(t, null).stars;
      expect(a!.companion).toBe(false);
      expect(b!.companion).toBe(true);
      expect((a!.x + b!.x) / 2).toBeCloseTo(SPLASH_LAYOUT.cx, 6);
      expect((a!.y + b!.y) / 2).toBeCloseTo(SPLASH_LAYOUT.cy, 6);
      const ra = Math.hypot(a!.x - SPLASH_LAYOUT.cx, a!.y - SPLASH_LAYOUT.cy);
      expect(ra).toBeCloseTo(SPLASH_LAYOUT.orbit * SPLASH_LAYOUT.markScale, 6);
    }
  });

  it('花瓣只动透明度和缩放：九片、缩放不小于 1、透明度在 0..1', () => {
    for (const ready of [null, 3]) {
      for (let t = 0; t < 8; t += 0.1) {
        const f = splashFrame(t, ready);
        expect(f.petals).toHaveLength(MARK_GEOMETRY.petals.length);
        for (const p of f.petals) {
          expect(p.scale).toBeGreaterThanOrEqual(1);
          expect(p.scale).toBeLessThanOrEqual(1.07 + 1e-9);
          expect(p.opacity).toBeGreaterThanOrEqual(0);
          expect(p.opacity).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('ready 后：合一 → 九瓣全亮 → 逐字点亮 → 淡出结束', () => {
    const r = 3;
    const bloomed = splashFrame(r + SPLASH_TIMING.bloom[1] + 0.01, r);
    for (const p of bloomed.petals) expect(p.opacity).toBeCloseTo(1, 5);
    const lit = splashFrame(r + SPLASH_TIMING.sweep[1] + 0.3, r);
    for (const l of lit.letters) expect(l.opacity).toBeCloseTo(1, 5);
    expect(lit.stars).toHaveLength(0);
    expect(splashFrame(r + SPLASH_FINISH_AFTER - 0.01, r).finished).toBe(false);
    const end = splashFrame(r + SPLASH_FINISH_AFTER, r);
    expect(end.finished).toBe(true);
    expect(end.layer).toBeCloseTo(0, 5);
  });

  it('ready 那一刻字不跳变', () => {
    const r = 2.9;
    const before = splashFrame(r - 1e-6, null);
    const after = splashFrame(r, r);
    before.letters.forEach((l, i) => expect(after.letters[i]!.opacity).toBeCloseTo(l.opacity, 3));
  });

  it('减弱动效的静态画面：完整横标、没有星', () => {
    const f = splashStaticFrame();
    expect(f.stars).toHaveLength(0);
    expect(f.petals.every((p) => p.opacity === 1 && p.scale === 1)).toBe(true);
    expect(f.letters.every((l) => l.opacity === 1 && l.dy === 0)).toBe(true);
  });
});

describe('背景星点', () => {
  it('从中心沿径向向外飞，光迹头尾在同一条射线上', () => {
    const lines = starfield(4, null, 1280, 720);
    expect(lines).toHaveLength(STARFIELD_COUNT);
    for (const s of lines) {
      const a1 = Math.atan2(s.y1 - 360, s.x1 - 640);
      const a2 = Math.atan2(s.y2 - 360, s.x2 - 640);
      expect(Math.abs(Math.sin(a1 - a2))).toBeLessThan(1e-9);
      expect(Math.hypot(s.x2 - 640, s.y2 - 360)).toBeGreaterThanOrEqual(Math.hypot(s.x1 - 640, s.y1 - 360));
    }
  });

  it('加载中慢速：每颗星至少约 5 秒才飞完全程', () => {
    expect(STARFIELD_MAX_SPEED).toBeLessThanOrEqual(0.21);
    expect(1 / STARFIELD_MAX_SPEED).toBeGreaterThan(4.7);
  });
});

describe('<SpicaSplash>', () => {
  it('服务端渲染出九瓣、五个字母、三颗星的位置', () => {
    const html = renderToStaticMarkup(createElement(SpicaSplash, { ready: false, theme: 'light', caption: 'v0.1.0' }));
    expect(html).toContain('data-theme="light"');
    expect(html.match(/spica-splash-petal spica-splash-petal--/g)).toHaveLength(9);
    expect(html.match(/class="spica-splash-letter/g)).toHaveLength(5);
    expect(html.match(/class="spica-splash-star"/g)).toHaveLength(3);
    expect(html).toContain('v0.1.0');
    for (const p of MARK_GEOMETRY.petals) expect(html).toContain(`d="${p.d}"`);
  });
});
