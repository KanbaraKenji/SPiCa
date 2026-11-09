/**
 * 开机画面「暗处亮起 · 双星环绕」的时间线（纯函数，不碰 DOM）。
 *
 * 画面是一块 1280 × 720 的舞台（React 组件按窗口等比缩放），花标 + 字标的大横标居中。
 * - 背景：星点从画面中心沿径向向外飘出，每颗星飘完全程固定 5 秒。
 * - 加载中：一蓝一白两颗星像真正的双星一样绕共同的中心（花心）转，两颗永远一前一后、相差半圈。
 *   轨道是椭圆，按开普勒第二定律走：离花心近时快、远时慢（快慢比是参数）；最近点转在前面（离观者近），
 *   所以星在前面时又快又大又亮、盖在花标上，在后面时慢、小、暗、被花标挡住。
 *   星从前面扫过哪片瓣，哪片亮起再慢慢暗下；字标五个字母随同一节拍起伏。
 * - 加载完成（ready）：双星平滑加速、螺旋收拢、合于花心 → 九瓣顺时针逐片点亮、轴弹一下、放一圈冲击环
 *   → 一道光从花心慢慢掠过字标，逐字点亮 → 停顿 → 整层淡出。每一步的时长都是参数（SPLASH_FINISH）。
 * 花瓣只动透明度和缩放，形状一笔不改。
 */
import { MARK_GEOMETRY, MARK_VIEWBOX, PETAL_COUNT } from './geometry.ts';
import { WORDMARK } from './wordmark.ts';

export const SPLASH_STAGE = Object.freeze({ width: 1280, height: 720 });

/** 加载中的节奏（秒） */
export const SPLASH_TIMING = Object.freeze({
  /** 背景：每颗星从中心飘到画面外的时间 */
  starfieldPeriod: 5,
  /** 双星转一圈的时间（缺省） */
  orbitPeriod: 4,
  /** 进场：花和字从暗处浮现 */
  appear: [0.2, 1.0] as const,
});

/**
 * 收尾每一步的时长（秒）。除 accel 外都从「双星合于花心」那一刻算起（= ready 之后 accel 秒）。
 */
export interface SplashFinish {
  /** ready 后双星与背景平滑加速、螺旋收拢到合一的时长 */
  accel: number;
  /** 合一那一刻双星的转速是平时的几倍 */
  orbitPeak: number;
  /** 合一那一刻背景星点的速度是平时的几倍 */
  starPeak: number;
  /** 背景星点从峰值平滑回落到平时速度的时长 */
  starSettle: number;
  /** 九瓣逐片点亮：从第一片开始的时刻、每片亮起用时、相邻两片的间隔（顺时针，12 点钟起） */
  petalStart: number;
  petalEach: number;
  petalStagger: number;
  /** 轴弹一下：开始时刻、用时 */
  hopStart: number;
  hop: number;
  /** 冲击环：开始时刻、扩散用时 */
  shockStart: number;
  shock: number;
  /** 光掠过字标：开始时刻、从花心走到字标末尾的用时 */
  sweepStart: number;
  sweep: number;
  /** 一切停住后开始淡出的时刻、淡出用时 */
  hold: number;
  fadeOut: number;
}

export const SPLASH_FINISH: Readonly<SplashFinish> = Object.freeze({
  accel: 2.0,
  orbitPeak: 4,
  starPeak: 3,
  starSettle: 1.5,
  petalStart: -0.1,
  petalEach: 0.45,
  petalStagger: 0.11, // 九片全部亮完 = 0.45 + 8 × 0.11 ≈ 1.33 秒
  hopStart: 0,
  hop: 0.6,
  shockStart: 0,
  shock: 1.4,
  sweepStart: 0.9,
  sweep: 1.5,
  hold: 3.6,
  fadeOut: 0.4,
});

/** 椭圆轨道：快慢比（最近点速度 ÷ 最远点速度），开普勒椭圆的偏心率 e = (k-1)/(k+1) */
export const SPLASH_ORBIT_DEFAULTS = Object.freeze({ speedRatio: 2 });

export interface SplashOptions {
  /** 双星转一圈的秒数（缺省 SPLASH_TIMING.orbitPeriod） */
  orbitPeriod?: number;
  /** 快慢比：离花心最近时的速度 ÷ 最远时的速度；1 = 匀速圆周（缺省 2） */
  speedRatio?: number;
  /** 收尾各步时长（缺省 SPLASH_FINISH） */
  finish?: Partial<SplashFinish>;
}

function finishOf(options: SplashOptions): SplashFinish {
  return { ...SPLASH_FINISH, ...options.finish };
}

/** 完成后多久整层消失（相对 ready） */
export function splashFinishAfter(finish: Partial<SplashFinish> = {}): number {
  const f = { ...SPLASH_FINISH, ...finish };
  return f.accel + f.hold + f.fadeOut;
}
/** 缺省时长下，完成后多久整层消失（相对 ready） */
export const SPLASH_FINISH_AFTER = splashFinishAfter();

// ---- 速度曲线（缓入：速度倍率 1 → peak，加速度从 0 起步）----
const easeIn = (x: number) => x * x;
const easeInArea = (x: number) => (x * x * x) / 3;
/** 平滑回落 1 - smoothstep 及其积分 */
const settleCurve = (x: number) => 1 - x * x * (3 - 2 * x);
const settleArea = (x: number) => x - x * x * x + (x * x * x * x) / 2;

/** 某一时刻的速度倍率（相对平时）：双星转速、背景星点速度。给曲线图和测试用 */
export function splashSpeeds(t: number, readyAt: number | null, options: SplashOptions = {}): { orbit: number; starfield: number } {
  if (readyAt === null || t < readyAt) return { orbit: 1, starfield: 1 };
  const c = finishOf(options);
  const u = t - readyAt;
  const a = Math.min(u / c.accel, 1);
  const orbit = u <= c.accel ? 1 + (c.orbitPeak - 1) * easeIn(a) : c.orbitPeak;
  const starfield = u <= c.accel
    ? 1 + (c.starPeak - 1) * easeIn(a)
    : 1 + (c.starPeak - 1) * settleCurve(Math.min((u - c.accel) / c.starSettle, 1));
  return { orbit, starfield };
}

/** 速度倍率对时间的积分减去 t 本身：加速带来的「额外走过的时间」 */
function extraTime(u: number, peak: number, accel: number): number {
  return (peak - 1) * accel * easeInArea(Math.min(u / accel, 1));
}

// ---- 版面 ----
const MARK_FRACTION = 0.36; // 花标占舞台高度
const S = (SPLASH_STAGE.height * MARK_FRACTION) / MARK_VIEWBOX; // 花标 64 单位 → 舞台像素
const K = S * MARK_GEOMETRY.params.scale; // 花瓣局部单位 → 舞台像素（含 1.15 放大）
const WORD_CAP = 96; // 字标大写高（舞台像素）
const WORD_SCALE = WORD_CAP / WORDMARK.height;
const GAP = 40;
const markW = MARK_VIEWBOX * S;
const wordW = WORDMARK.width * WORD_SCALE;
const x0 = (SPLASH_STAGE.width - (markW + GAP + wordW)) / 2;

export const SPLASH_LAYOUT = Object.freeze({
  /** 花心 */
  cx: x0 + markW / 2,
  cy: SPLASH_STAGE.height / 2 + 6,
  /** 花瓣组的缩放（局部 64 坐标 → 舞台） */
  markScale: K,
  /** 字标左上角与缩放 */
  wordX: x0 + markW + GAP,
  wordY: SPLASH_STAGE.height / 2 + 6 - WORD_CAP / 2,
  wordScale: WORD_SCALE,
});

/**
 * 双星轨道（花标局部单位）：半长轴 32 的椭圆，花心在焦点上；轨道平面倾斜，
 * 投影到屏幕上竖向压到 0.36、整体转 -18°。最近点朝前（屏幕下方、离观者近）。
 */
export const SPLASH_ORBIT = Object.freeze({ semiMajor: 32, squash: 0.36, roll: -18 });

// ---- 小工具 ----
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const outCubic = (x: number) => 1 - (1 - x) ** 3;
const inOutCubic = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * 开普勒运动：平近点角 M（弧度，随时间匀速走）→ 离花心的距离（以半长轴为 1）与真近点角。
 * 解 E - e·sinE = M（牛顿迭代）。
 */
export function keplerPosition(M: number, e: number): { r: number; angle: number } {
  if (e <= 0) return { r: 1, angle: M };
  let E = M;
  for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const angle = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  return { r: 1 - e * Math.cos(E), angle };
}

/** 轨道平面上（相对花心）的一点 → 屏幕位置与纵深 depth（-1 后 … 1 前） */
function project(px: number, py: number, depthRef: number) {
  const ex = px;
  const ey = py * SPLASH_ORBIT.squash;
  const roll = rad(SPLASH_ORBIT.roll);
  const lx = ex * Math.cos(roll) - ey * Math.sin(roll);
  const ly = ex * Math.sin(roll) + ey * Math.cos(roll);
  return {
    x: SPLASH_LAYOUT.cx + K * lx,
    y: SPLASH_LAYOUT.cy + K * ly,
    depth: Math.max(-1, Math.min(1, py / depthRef)),
    /** 屏幕上从 12 点钟顺时针量的角度，用来判断扫过哪片瓣 */
    screenAngle: (Math.atan2(lx, -ly) * 180) / Math.PI,
  };
}

/** 星扫过之后瓣的亮度：刚扫过最亮，之后指数变暗 */
function litByStar(petalAngle: number, starDeg: number): number {
  const behind = (((starDeg - petalAngle) % 360) + 360) % 360;
  return behind < 300 ? Math.exp(-behind / 70) : 0;
}

/** 加载中字母的起伏（0..1）：两颗星相差半圈，所以字按半圈一拍 */
function letterWave(t: number, j: number, n: number, beat: number): number {
  return (0.5 + 0.5 * Math.cos(2 * Math.PI * (t / beat - j / n))) ** 3;
}

export interface SplashStar {
  x: number;
  y: number;
  opacity: number;
  /** 大小倍率（前面大、后面小） */
  scale: number;
  /** true = 在花标前面（盖住花标），false = 在花标后面（被花标挡住） */
  front: boolean;
  /** false = 蓝星（强调色），true = 白色伴星 */
  companion: boolean;
}

export interface SplashFrame {
  /** 整层透明度（淡出时 1 → 0） */
  layer: number;
  /** 进场透明度 */
  appear: number;
  petals: ReadonlyArray<{ opacity: number; scale: number }>;
  hubScale: number;
  /** 花心光晕强度 0..1（浅色主题不画） */
  glow: number;
  /** 冲击环（舞台像素） */
  shock: { r: number; opacity: number; width: number } | null;
  /** 双星与掠字的光 */
  stars: readonly SplashStar[];
  letters: ReadonlyArray<{ opacity: number; dy: number }>;
  /** 收尾结束、可以移除 */
  finished: boolean;
}

const LETTER_BASE = 0.22;
const LETTER_WAVE = 0.3;
const BACK_DIM = 0.35; // 星在后面时点亮花瓣的力度

/**
 * 某一时刻的画面状态。
 * @param t 从开机画面出现算起的秒数
 * @param readyAt 加载完成的时刻（秒）；还没完成传 null
 */
export function splashFrame(t: number, readyAt: number | null, options: SplashOptions = {}): SplashFrame {
  const L = SPLASH_LAYOUT;
  const period = options.orbitPeriod ?? SPLASH_TIMING.orbitPeriod;
  const k = Math.max(1, options.speedRatio ?? SPLASH_ORBIT_DEFAULTS.speedRatio);
  const e = (k - 1) / (k + 1);
  const F = finishOf(options);
  const finishAfter = splashFinishAfter(F);
  const beat = period / 2;
  const n = WORDMARK.shapes.length;
  const appear = seg(t, SPLASH_TIMING.appear[0], SPLASH_TIMING.appear[1]);
  const petalLit = new Array<number>(PETAL_COUNT).fill(0);
  const stars: SplashStar[] = [];
  const letters: Array<{ opacity: number; dy: number }> = [];
  const done = readyAt !== null && t >= readyAt;
  const u = done ? t - readyAt : 0; // 收尾进行了多久
  const m = u - F.accel; // 相对双星合一那一刻

  // 双星：平近点角随时间匀速走（完成后按缓入曲线加速），位置按开普勒椭圆算；完成后半径同时收拢到 0
  const merge = done ? inOutCubic(seg(u, 0, F.accel)) : 0;
  const M = (2 * Math.PI * (t + (done ? extraTime(u, F.orbitPeak, F.accel) : 0))) / period;
  const a = SPLASH_ORBIT.semiMajor * (1 - merge);
  const depthRef = SPLASH_ORBIT.semiMajor * (1 + e);
  if (!done || merge < 1) {
    const kp = keplerPosition(M, e);
    // 最近点（真近点角 0）朝前：轨道平面里 +y 是前方
    const px = a * kp.r * Math.cos(kp.angle + Math.PI / 2);
    const py = a * kp.r * Math.sin(kp.angle + Math.PI / 2);
    for (const [sx, sy, companion] of [[px, py, false], [-px, -py, true]] as const) {
      const p = project(sx, sy, depthRef);
      stars.push({
        x: p.x,
        y: p.y,
        opacity: (done ? 1 : appear) * (0.6 + 0.4 * p.depth),
        scale: 1 + 0.35 * p.depth,
        front: p.depth >= 0,
        companion,
      });
      const strength = p.depth >= 0 ? 1 : BACK_DIM;
      MARK_GEOMETRY.petals.forEach((petal, i) => {
        petalLit[i] = Math.max(petalLit[i] ?? 0, strength * litByStar(petal.angle, p.screenAngle));
      });
    }
  }

  // 九瓣顺时针逐片点亮
  const petalBloom = (i: number) => (done ? outCubic(seg(m, F.petalStart + i * F.petalStagger, F.petalStart + i * F.petalStagger + F.petalEach)) : 0);
  const allBloom = done ? petalBloom(PETAL_COUNT - 1) : 0;

  // 字标
  if (!done) {
    for (let j = 0; j < n; j++) {
      const w = letterWave(t, j, n, beat);
      letters.push({ opacity: appear * (LETTER_BASE + LETTER_WAVE * w), dy: -2.5 * w });
    }
  } else {
    const c = seg(m, F.sweepStart, F.sweepStart + F.sweep);
    const sweepX = lerp(L.cx, L.wordX + WORDMARK.width * L.wordScale + 80, inOutCubic(c));
    if (c > 0 && c < 1) {
      stars.push({ x: sweepX, y: L.cy - 6, opacity: 1 - seg(c, 0.85, 1), scale: 0.85, front: true, companion: false });
    }
    // ready 那一刻的起伏在 0.3s 内回落到底色，再等光掠过点亮，避免跳变
    const settle = seg(u, 0, 0.3);
    WORDMARK.shapes.forEach((shape, j) => {
      const w = letterWave(readyAt!, j, n, beat) * (1 - settle);
      const base = LETTER_BASE + LETTER_WAVE * w;
      // 光走到字母中心前 20 像素开始亮，越过 90 像素亮满
      const lit = c > 0 ? outCubic(seg(sweepX - (L.wordX + shape.cx * L.wordScale), -20, 90)) : 0;
      letters.push({ opacity: lerp(base, 1, lit), dy: lit > 0 ? 8 * (1 - lit) : -2.5 * w });
    });
  }

  const petals = MARK_GEOMETRY.petals.map((_, i) => {
    const b = petalBloom(i);
    const lit = lerp(petalLit[i] ?? 0, 1, b);
    return { opacity: appear * (0.2 + 0.8 * lit), scale: 1 + 0.07 * lit * (1 - b) };
  });

  const hop = done ? seg(m, F.hopStart, F.hopStart + F.hop) : 0;
  const flash = done && m > 0 ? Math.exp(-m * 1.5) : 0;
  const sw = done ? seg(m, F.shockStart, F.shockStart + F.shock) : 0;
  const shock = sw > 0 && sw < 1
    ? { r: K * (6 + 60 * outCubic(sw)), opacity: 0.45 * (1 - sw), width: 3 * (1 - sw) }
    : null;
  const fade = done ? seg(m, F.hold, F.hold + F.fadeOut) : 0;

  return {
    layer: 1 - fade,
    appear,
    petals,
    hubScale: 1 + 0.6 * Math.sin(Math.PI * hop),
    glow: clamp(0.1 + 0.4 * allBloom + 0.35 * flash),
    shock,
    stars,
    letters,
    finished: done && u >= finishAfter,
  };
}

/** 减弱动效时的静态画面：完整横标，不放星点 */
export function splashStaticFrame(): SplashFrame {
  return {
    layer: 1,
    appear: 1,
    petals: MARK_GEOMETRY.petals.map(() => ({ opacity: 1, scale: 1 })),
    hubScale: 1,
    glow: 0.5,
    shock: null,
    stars: [],
    letters: WORDMARK.shapes.map(() => ({ opacity: 1, dy: 0 })),
    finished: false,
  };
}

// ---- 背景星点 ----

export interface StarStreak {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  opacity: number;
  /** 用强调色画（否则用星点色） */
  accent: boolean;
}

interface StarSeed { angle: number; phase: number; big: boolean; accent: boolean }

function seeded(seed: number) {
  let x = seed;
  return () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

export const STARFIELD_COUNT = 120;
const STAR_SEEDS: readonly StarSeed[] = (() => {
  const r = seeded(5);
  return Array.from({ length: STARFIELD_COUNT }, () => ({
    angle: r() * 360,
    phase: r(),
    big: r() < 0.1,
    accent: r() < 0.25,
  }));
})();

/** 星点的「时间」：加载完成后按同一条缓入曲线加速，合一后再平滑回落（速度连续，没有台阶） */
function starTime(t: number, readyAt: number | null, options: SplashOptions = {}): number {
  if (readyAt === null || t < readyAt) return t;
  const c = finishOf(options);
  const u = t - readyAt;
  const up = extraTime(u, c.starPeak, c.accel);
  const down = u > c.accel ? (c.starPeak - 1) * c.starSettle * settleArea(Math.min((u - c.accel) / c.starSettle, 1)) : 0;
  return t + up + down;
}

/**
 * 背景星点的光迹（像素坐标，按画布实际大小算，中心在画布中心）。
 * 每颗星飘完全程的时间相同（SPLASH_TIMING.starfieldPeriod），起点相位各不相同。
 * @param scale 线宽倍率（高分屏传 devicePixelRatio × 舞台缩放）
 */
export function starfield(t: number, readyAt: number | null, width: number, height: number, scale = 1, options: SplashOptions = {}): StarStreak[] {
  const u = starTime(t, readyAt, options) / SPLASH_TIMING.starfieldPeriod;
  const fadeIn = seg(t, 0, 0.8);
  const rMax = Math.hypot(width, height) / 2;
  const cx = width / 2;
  const cy = height / 2;
  const trail = 0.035;
  return STAR_SEEDS.map((s) => {
    const life = (u + s.phase) % 1;
    const d = 30 * scale + (rMax + 60 * scale) * life ** 2.2;
    const dPrev = 30 * scale + (rMax + 60 * scale) * Math.max(0, life - trail) ** 2.2;
    const ux = Math.cos(rad(s.angle));
    const uy = Math.sin(rad(s.angle));
    return {
      x1: cx + ux * dPrev,
      y1: cy + uy * dPrev,
      x2: cx + ux * d,
      y2: cy + uy * d,
      width: (0.7 + life * (s.big ? 2.0 : 1.2)) * scale,
      opacity: fadeIn * clamp(life * 4) * (s.big ? 0.7 : 0.42),
      accent: s.accent,
    };
  });
}
