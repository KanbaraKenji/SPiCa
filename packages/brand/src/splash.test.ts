import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  SPLASH_BRIEF,
  SPLASH_FINISH,
  SPLASH_FINISH_AFTER,
  SPLASH_LAYOUT,
  SPLASH_TIMING,
  STARFIELD_COUNT,
  keplerPosition,
  splashBriefFrame,
  splashFrame,
  splashOrbitScale,
  splashSchedule,
  splashSpeeds,
  splashStaticFrame,
  starfield,
} from './splash.ts';
import { MARK_GEOMETRY } from './geometry.ts';
import { SpicaSplash } from './react/SpicaSplash.tsx';

const R = 5; // 测试里 ready 的时刻
const S = splashSchedule();

describe('加载中', () => {
  it('没 ready 就一直循环，不会结束', () => {
    for (const t of [0, 1, 5, 60, 600]) {
      const f = splashFrame(t, null);
      expect(f.finished).toBe(false);
      expect(f.layer).toBe(1);
      expect(f.stars).toHaveLength(2);
      expect(f.fill).toBeNull();
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

  it('双星一圈 3.5 秒，背景星点仍 5 秒一程', () => {
    expect(SPLASH_TIMING.orbitPeriod).toBe(3.5);
    expect(SPLASH_TIMING.starfieldPeriod).toBe(5);
    const a = splashFrame(1.5, null).stars[0]!;
    const b = splashFrame(1.5 + 3.5, null).stars[0]!;
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
  });

  it('开普勒椭圆：近快远慢、快的一段在前面', () => {
    expect(keplerPosition(0, 1 / 3).r).toBeCloseTo(2 / 3, 6);
    expect(keplerPosition(Math.PI, 1 / 3).r).toBeCloseTo(4 / 3, 6);
    expect(keplerPosition(1.234, 0)).toEqual({ r: 1, angle: 1.234 });
    const dt = 1e-4;
    let maxV = 0;
    let minV = Infinity;
    let maxFront = false;
    for (let t = 1.2; t < 1.2 + SPLASH_TIMING.orbitPeriod; t += 0.01) {
      const p = splashFrame(t, null).stars[0]!;
      const q = splashFrame(t + dt, null).stars[0]!;
      const v = Math.hypot(q.x - p.x, q.y - p.y) / dt;
      if (v > maxV) {
        maxV = v;
        maxFront = p.front;
      }
      minV = Math.min(minV, v);
    }
    expect(maxFront).toBe(true);
    expect(maxV / minV).toBeGreaterThan(1.5);
  });

  it('花瓣不再和星的位置对应：九片同一个亮度，随节拍呼吸', () => {
    const values = new Set<number>();
    for (let t = 1.2; t < 5; t += 0.05) {
      const f = splashFrame(t, null);
      const first = f.petals[0]!.opacity;
      for (const p of f.petals) {
        expect(p.opacity).toBeCloseTo(first, 9);
        expect(p.scale).toBe(1);
      }
      values.add(Math.round(first * 100));
    }
    expect(values.size).toBeGreaterThan(5); // 在起伏，不是常量
  });
});

describe('收尾', () => {
  it('时间表按顺序首尾相接，扫字 0.6～0.9 秒', () => {
    const F = SPLASH_FINISH;
    expect(S.bigStart).toBeCloseTo(F.expand, 9);
    expect(S.collapseStart - S.bigStart).toBeCloseTo((F.bigTurns * SPLASH_TIMING.orbitPeriod) / F.bigSpeed, 9);
    expect(S.merge - S.collapseStart).toBeCloseTo(F.collapse, 9);
    expect(S.fillEnd - S.merge).toBeCloseTo(F.fill, 9);
    expect(S.sweepEnd - S.sweepStart).toBeCloseTo(F.sweep, 9);
    expect(F.sweep).toBeGreaterThanOrEqual(0.6);
    expect(F.sweep).toBeLessThanOrEqual(0.9);
    expect(SPLASH_FINISH_AFTER).toBeCloseTo(S.end, 9);
  });

  it('顺序定死：扩轨 → 大半径绕满 2 圈 → 两圈一结束直接扎进花心（≤ 0.4 秒，只走一小段短弧）', () => {
    const F = SPLASH_FINISH;
    expect(S.bigStart).toBeCloseTo(F.expand, 9);
    expect(splashOrbitScale(R + S.bigStart + 0.01, R)).toBeCloseTo(F.bigRadius, 6);
    const dt = 0.0002;
    let big = 0;
    for (let t = R + S.bigStart; t < R + S.collapseStart; t += dt) big += (splashSpeeds(t, R).orbit * dt) / SPLASH_TIMING.orbitPeriod;
    expect(big).toBeCloseTo(2, 2);
    expect(S.merge - S.collapseStart).toBeLessThanOrEqual(0.4);
    let dive = 0;
    for (let t = R + S.collapseStart; t < R + S.merge; t += dt) dive += (splashSpeeds(t, R).orbit * dt) / SPLASH_TIMING.orbitPeriod;
    expect(dive * 360).toBeLessThan(60); // 扎心时转过不到 60°
    // 扎心时半径只缩不涨、越缩越快
    const k1 = splashOrbitScale(R + S.collapseStart + 0.1, R);
    const k2 = splashOrbitScale(R + S.collapseStart + 0.2, R);
    const k3 = splashOrbitScale(R + S.collapseStart + 0.3, R);
    expect(F.bigRadius - k1).toBeLessThan(k1 - k2);
    expect(k1 - k2).toBeLessThan(k2 - k3);
  });

  it('拖尾：加载中短而淡，收尾拉长变浓，合心后消失', () => {
    const F = SPLASH_FINISH;
    expect(F.loadTrail).toBeLessThan(F.trail);
    const load = splashFrame(3, null).trails;
    const finish = splashFrame(R + 0.4, R).trails;
    expect(load.length).toBeGreaterThan(10);
    expect(Math.max(...load.map((d) => d.opacity))).toBeLessThan(Math.max(...finish.map((d) => d.opacity)));
    expect(splashFrame(R + S.merge + 0.01, R).trails).toHaveLength(0);
  });

  it('双星从各自所在的一侧飞进花心（两条弧线，始终关于花心对称）', () => {
    for (let t = R; t < R + S.merge - 0.02; t += 0.05) {
      const [a, b] = splashFrame(t, R).stars;
      expect((a!.x + b!.x) / 2).toBeCloseTo(SPLASH_LAYOUT.cx, 6);
      expect((a!.y + b!.y) / 2).toBeCloseTo(SPLASH_LAYOUT.cy, 6);
    }
  });

  it('轴心：加载中半透明，合心后变实', () => {
    for (const t of [1.5, 2.5, 3.5]) {
      const h = splashFrame(t, null).hubOpacity;
      expect(h).toBeGreaterThan(0.35);
      expect(h).toBeLessThan(0.6);
    }
    expect(splashFrame(R + S.merge + 0.3, R).hubOpacity).toBeCloseTo(1, 6);
  });

  it('合心那一帧：双星消失，水波填充从花心开始，填满时半径覆盖整朵花', () => {
    const before = splashFrame(R + S.merge - 0.01, R);
    expect(before.stars).toHaveLength(2);
    expect(before.fill).toBeNull();
    const at = splashFrame(R + S.merge + 0.001, R);
    expect(at.stars).toHaveLength(0);
    expect(at.fill!.radius).toBeLessThan(1);
    const full = splashFrame(R + S.fillEnd + 0.01, R);
    expect(full.fill!.radius).toBeCloseTo(SPLASH_LAYOUT.fillRadius, 6);
    expect(SPLASH_LAYOUT.fillRadius).toBeGreaterThan(29); // 长瓣尖离花心 29
  });

  it('扫字：经过处字亮满并闪一下辉光，结束后辉光回稳到 0', () => {
    const mid = splashFrame(R + S.sweepStart + SPLASH_FINISH.sweep * 0.5, R);
    expect(Math.max(...mid.letters.map((l) => l.glow))).toBeGreaterThan(0.3);
    const after = splashFrame(R + S.sweepEnd + SPLASH_FINISH.letterGlow + 0.05, R);
    for (const l of after.letters) {
      expect(l.opacity).toBeCloseTo(1, 3);
      expect(l.glow).toBe(0);
    }
  });

  it('淡出后结束', () => {
    expect(splashFrame(R + S.end - 0.01, R).finished).toBe(false);
    const end = splashFrame(R + S.end + 1e-6, R);
    expect(end.finished).toBe(true);
    expect(end.layer).toBeCloseTo(0, 5);
  });

  it('速度连续：双星和背景都没有台阶', () => {
    let prev = splashSpeeds(R - 0.001, R);
    expect(prev).toEqual({ orbit: 1, starfield: 1 });
    for (let t = R; t < R + S.end; t += 0.001) {
      const s = splashSpeeds(t, R);
      expect(Math.abs(s.orbit - prev.orbit)).toBeLessThan(0.03);
      expect(Math.abs(s.starfield - prev.starfield)).toBeLessThan(0.02);
      prev = s;
    }
  });

  it('双星位置连续（没有跳帧）', () => {
    let prev = splashFrame(R - 0.004, null).stars[0]!;
    for (let t = R; t < R + S.merge - 0.01; t += 0.004) {
      const s = splashFrame(t, R).stars[0]!;
      expect(Math.hypot(s.x - prev.x, s.y - prev.y)).toBeLessThan(12);
      prev = s;
    }
  });
});

describe('短版与减弱动效', () => {
  it('短版：1 秒内淡入、停住、淡出；ready 晚了就停在完整横标上等', () => {
    const B = SPLASH_BRIEF;
    expect(B.fadeIn + B.hold + B.fadeOut).toBeLessThanOrEqual(1);
    expect(splashBriefFrame(0.5, 0).layer).toBe(1);
    expect(splashBriefFrame(1.0001, 0).finished).toBe(true);
    expect(splashBriefFrame(3, null).finished).toBe(false);
    expect(splashBriefFrame(3, null).layer).toBe(1);
    expect(splashBriefFrame(3.31, 3).finished).toBe(true);
    expect(splashBriefFrame(0.5, 0).stars).toHaveLength(0);
  });

  it('减弱动效的静态画面：完整横标、没有星', () => {
    const f = splashStaticFrame();
    expect(f.stars).toHaveLength(0);
    expect(f.trails).toHaveLength(0);
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
    }
  });

  it('可以指定原点：所有星点都从花心向外飞', () => {
    const o = { x: SPLASH_LAYOUT.cx, y: SPLASH_LAYOUT.cy };
    for (const s of starfield(4, null, 1280, 720, 1, {}, o)) {
      const a1 = Math.atan2(s.y1 - o.y, s.x1 - o.x);
      const a2 = Math.atan2(s.y2 - o.y, s.x2 - o.x);
      expect(Math.abs(Math.sin(a1 - a2))).toBeLessThan(1e-9);
    }
  });

  it('5 秒一程，之后从中心重来', () => {
    const a = starfield(2, null, 1280, 720);
    const b = starfield(7, null, 1280, 720);
    a.forEach((s, i) => expect(b[i]!.x2).toBeCloseTo(s.x2, 6));
  });
});

describe('<SpicaSplash>', () => {
  it('服务端渲染出暗花标、实色花标（带遮罩）、涟漪、五个字母和辉光层、星与拖尾的位置', () => {
    const html = renderToStaticMarkup(createElement(SpicaSplash, { ready: false, theme: 'light', caption: 'v0.1.0' }));
    expect(html).toContain('data-theme="light"');
    expect(html).toContain('data-mode="full"');
    expect(html).toContain('clip-path="url(#');
    expect(html.match(/class="spica-splash-ripple"/g)).toHaveLength(2);
    expect(html.match(/class="spica-splash-letter(?: |")/g)).toHaveLength(5);
    expect(html.match(/class="spica-splash-letter-glow"/g)).toHaveLength(5);
    expect(html.match(/class="spica-splash-star"/g)).toHaveLength(6);
    expect(html).toContain('spica-splash-trail');
    expect(html).toContain('v0.1.0');
    for (const p of MARK_GEOMETRY.petals) expect(html).toContain(`d="${p.d}"`);
  });

  it('短版模式标在根元素上', () => {
    const html = renderToStaticMarkup(createElement(SpicaSplash, { ready: true, mode: 'brief' }));
    expect(html).toContain('data-mode="brief"');
  });
});
