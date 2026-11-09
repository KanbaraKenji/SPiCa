import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { SPLASH_FINISH, SPLASH_FINISH_AFTER, SPLASH_LAYOUT, SPLASH_TIMING, STARFIELD_COUNT, keplerPosition, splashFrame, splashSpeeds, splashStaticFrame, starfield } from './splash.ts';
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

  it('双星相差半圈：中点就是花心，一前一后', () => {
    for (const t of [0.7, 2.3, 4.1]) {
      const [a, b] = splashFrame(t, null).stars;
      expect(a!.companion).toBe(false);
      expect(b!.companion).toBe(true);
      expect((a!.x + b!.x) / 2).toBeCloseTo(SPLASH_LAYOUT.cx, 6);
      expect((a!.y + b!.y) / 2).toBeCloseTo(SPLASH_LAYOUT.cy, 6);
      expect(a!.front).not.toBe(b!.front);
    }
  });

  it('三维环绕：在前面时大、亮，在后面时小、暗', () => {
    let sawFront = false;
    let sawBack = false;
    for (let t = 1.2; t < 1.2 + SPLASH_TIMING.orbitPeriod; t += 0.1) {
      for (const s of splashFrame(t, null).stars) {
        if (s.front) {
          sawFront = true;
          expect(s.scale).toBeGreaterThanOrEqual(1);
        } else {
          sawBack = true;
          expect(s.scale).toBeLessThan(1);
          expect(s.opacity).toBeLessThan(0.61);
        }
      }
    }
    expect(sawFront && sawBack).toBe(true);
  });

  it('双星一圈 3.5 秒，背景星点仍 5 秒一程（不同拍）', () => {
    expect(SPLASH_TIMING.orbitPeriod).toBe(3.5);
    expect(SPLASH_TIMING.starfieldPeriod).toBe(5);
    const a = splashFrame(1.5, null).stars[0]!;
    const b = splashFrame(1.5 + 3.5, null).stars[0]!;
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
  });

  it('开普勒椭圆：最近点比最远点快约 2 倍，且最近点在前面', () => {
    const near = keplerPosition(0, 1 / 3);
    const far = keplerPosition(Math.PI, 1 / 3);
    expect(near.r).toBeCloseTo(2 / 3, 6);
    expect(far.r).toBeCloseTo(4 / 3, 6);
    // 角速度 ∝ 1/r²，线速度比 = (1+e)/(1-e) = 2
    const dt = 1e-4;
    const speed = (t: number) => {
      const p = splashFrame(t, null).stars[0]!;
      const q = splashFrame(t + dt, null).stars[0]!;
      return { v: Math.hypot(q.x - p.x, q.y - p.y) / dt, front: p.front };
    };
    let maxV = 0, minV = Infinity, maxFront = false;
    for (let t = 1.2; t < 1.2 + SPLASH_TIMING.orbitPeriod; t += 0.01) {
      const s = speed(t);
      if (s.v > maxV) { maxV = s.v; maxFront = s.front; }
      minV = Math.min(minV, s.v);
    }
    expect(maxFront).toBe(true);
    expect(maxV / minV).toBeGreaterThan(1.5);
  });

  it('快慢比 1 时退化成匀速圆周', () => {
    const a = keplerPosition(1.234, 0);
    expect(a.r).toBe(1);
    expect(a.angle).toBeCloseTo(1.234, 9);
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
    const merged = r + SPLASH_FINISH.accel;
    const F = SPLASH_FINISH;
    const bloomed = splashFrame(merged + F.petalStart + 8 * F.petalStagger + F.petalEach + 0.01, r);
    for (const p of bloomed.petals) expect(p.opacity).toBeCloseTo(1, 5);
    const lit = splashFrame(merged + F.sweepStart + F.sweep + 0.3, r);
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

describe('收尾加速曲线', () => {
  it('ready 前后速度连续：没有台阶，起步加速度为 0', () => {
    const r = 5;
    let prev = splashSpeeds(r - 0.001, r);
    expect(prev).toEqual({ orbit: 1, starfield: 1 });
    for (let t = r; t < r + 5; t += 0.001) {
      const s = splashSpeeds(t, r);
      expect(Math.abs(s.orbit - prev.orbit)).toBeLessThan(0.02);
      expect(Math.abs(s.starfield - prev.starfield)).toBeLessThan(0.01);
      prev = s;
    }
    // 刚 ready 0.1 秒时几乎还是平时的速度（缓入）
    expect(splashSpeeds(r + 0.1, r).orbit).toBeLessThan(1.02);
  });

  it('合一时转速到峰值，背景星点之后回落到平时速度', () => {
    const r = 5;
    const c = SPLASH_FINISH;
    expect(splashSpeeds(r + c.accel, r).orbit).toBeCloseTo(c.orbitPeak * c.finalBoost, 6);
    expect(splashSpeeds(r + c.accel, r).starfield).toBeCloseTo(c.starPeak, 6);
    expect(splashSpeeds(r + c.accel + c.starSettle + 0.1, r).starfield).toBeCloseTo(1, 6);
  });

  it('双星和背景星点的位置随时间连续变化（没有跳帧）', () => {
    const r = 5;
    let prevStar = splashFrame(r - 0.004, null).stars[0]!;
    let prevBg = starfield(r - 0.004, null, 1280, 720);
    for (let t = r; t < r + SPLASH_FINISH.accel - 0.01; t += 0.004) {
      const star = splashFrame(t, r).stars[0]!;
      expect(Math.hypot(star.x - prevStar.x, star.y - prevStar.y)).toBeLessThan(6);
      prevStar = star;
      const bg = starfield(t, r, 1280, 720);
      bg.forEach((s, i) => {
        const p = prevBg[i]!;
        // 一颗星飘出画面后会从中心重来，那一帧跳回中心，不算
        if (Math.hypot(s.x2 - 640, s.y2 - 360) >= Math.hypot(p.x2 - 640, p.y2 - 360)) {
          expect(Math.hypot(s.x2 - p.x2, s.y2 - p.y2)).toBeLessThan(25);
        }
      });
      prevBg = bg;
    }
  });

  it('收尾时长可调：时长变了，结束时间跟着变', () => {
    const r = 5;
    const F = SPLASH_FINISH;
    const f = splashFrame(r + 2.6 + F.hold + F.fadeOut + 1e-6, r, { finish: { accel: 2.6 } });
    expect(f.finished).toBe(true);
    expect(splashFrame(r + 2.6 + F.hold, r, { finish: { accel: 2.6 } }).finished).toBe(false);
  });

  it('收尾：九瓣逐片点亮 ≥ 1.2 秒、光掠过字标 ≥ 0.8 秒', () => {
    const F = SPLASH_FINISH;
    expect(F.petalEach + 8 * F.petalStagger).toBeGreaterThanOrEqual(1.2);
    expect(F.sweep).toBeGreaterThanOrEqual(0.8);
    expect(SPLASH_FINISH_AFTER).toBeCloseTo(F.accel + F.hold + F.fadeOut, 9);
  });

  it('九瓣填满的那一帧就是双星合于花心、消失的那一帧', () => {
    const r = 5;
    const F = SPLASH_FINISH;
    const before = splashFrame(r + F.accel - 0.3, r);
    expect(before.stars).toHaveLength(2); // 双星还在
    expect(before.petals[8]!.opacity).toBeLessThan(0.95); // 最后一片还在亮起中
    const at = splashFrame(r + F.accel + 1e-6, r);
    for (const p of at.petals) expect(p.opacity).toBeCloseTo(1, 3);
    expect(at.stars.filter((s) => s.scale !== 0.85)).toHaveLength(0); // 只剩（还没出现的）掠字光，没有双星
  });

  it('合心前最后一段再加速：峰值 4 × 1.8 = 7.2 倍，远低于旧版的 21 倍；再加速开始前和原曲线一样', () => {
    const r = 5;
    const F = SPLASH_FINISH;
    const peak = splashSpeeds(r + F.accel, r).orbit;
    expect(peak).toBeCloseTo(7.2, 6);
    expect(peak).toBeLessThan(10);
    const u = F.accel - F.finalBoostTime;
    expect(splashSpeeds(r + u, r).orbit).toBeCloseTo(1 + (F.orbitPeak - 1) * (u / F.accel) ** 2, 9);
  });

  it('加速段里双星至少再绕 2 圈', () => {
    const F = SPLASH_FINISH;
    const turns = (F.accel * (1 + (F.orbitPeak - 1) / 3)) / SPLASH_TIMING.orbitPeriod;
    expect(turns).toBeGreaterThanOrEqual(2);
  });});

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

  it('背景节拍：每颗星 5 秒飘完全程，之后从中心重来', () => {
    const p = SPLASH_TIMING.starfieldPeriod;
    expect(p).toBe(5);
    const a = starfield(2, null, 1280, 720);
    const b = starfield(2 + p, null, 1280, 720);
    a.forEach((s, i) => {
      expect(b[i]!.x2).toBeCloseTo(s.x2, 6);
      expect(b[i]!.y2).toBeCloseTo(s.y2, 6);
    });
  });
});

describe('<SpicaSplash>', () => {
  it('服务端渲染出九瓣、五个字母、三颗星的位置', () => {
    const html = renderToStaticMarkup(createElement(SpicaSplash, { ready: false, theme: 'light', caption: 'v0.1.0' }));
    expect(html).toContain('data-theme="light"');
    expect(html.match(/spica-splash-petal spica-splash-petal--/g)).toHaveLength(9);
    expect(html.match(/class="spica-splash-letter/g)).toHaveLength(5);
    expect(html.match(/class="spica-splash-star"/g)).toHaveLength(6); // 后面三个、前面三个
    expect(html).toContain('spica-splash-mask');
    expect(html).toContain('v0.1.0');
    for (const p of MARK_GEOMETRY.petals) expect(html).toContain(`d="${p.d}"`);
  });
});
