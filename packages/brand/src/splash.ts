/**
 * 开机画面「暗处亮起 · 双星环绕」的时间线（纯函数，不碰 DOM）。
 *
 * 画面是一块 1280 × 720 的舞台（React 组件按窗口等比缩放），花标 + 字标的大横标居中。
 * - 背景：星点从画面中心沿径向向外飘出，每颗星飘完全程固定 6 秒（背景节拍）。
 * - 加载中：一蓝一白两颗星在一条倾斜的椭圆轨道上绕花标转，相差半圈；转到前面时大、亮、
 *   盖在花标上，转到后面时小、暗、被花标挡住。双星转一圈的时间锁在背景节拍上（等于或两倍）。
 *   星从前面扫过哪片瓣，哪片亮起再慢慢暗下；字标五个字母随同一节拍起伏。
 * - 加载完成（ready）：双星螺旋收拢、合于花心 → 九瓣全亮、轴弹一下、放一圈冲击环；
 *   一道光从花心掠过字标，逐字点亮 → 停顿 → 整层淡出。
 * 花瓣只动透明度和缩放，形状一笔不改。
 */
import { MARK_GEOMETRY, MARK_VIEWBOX, PETAL_COUNT } from './geometry.ts';
import { WORDMARK } from './wordmark.ts';

export const SPLASH_STAGE = Object.freeze({ width: 1280, height: 720 });

/** 时间（秒） */
export const SPLASH_TIMING = Object.freeze({
  /** 背景节拍：每颗背景星从中心飘到画面外的时间 */
  starfieldPeriod: 6,
  /** 进场：花和字从暗处浮现 */
  appear: [0.2, 1.0] as const,
  /** 以下相对 ready 那一刻 */
  merge: 0.9, // 双星螺旋收拢用时
  bloom: [0.85, 1.15] as const, // 九瓣全亮
  hop: [0.85, 1.25] as const, // 轴弹一下
  shock: [0.87, 1.65] as const, // 冲击环
  sweep: [1.0, 1.7] as const, // 掠字的光
  hold: 2.6, // 收尾动画结束、开始淡出
  fadeOut: 0.26,
});

/** 双星转一圈的时间：sync = 与背景同拍；slow = 背景的两倍慢 */
export const SPLASH_TEMPOS = Object.freeze({
  sync: SPLASH_TIMING.starfieldPeriod,
  slow: SPLASH_TIMING.starfieldPeriod * 2,
});
export type SplashTempo = keyof typeof SPLASH_TEMPOS;

export interface SplashOptions {
  /** 双星转一圈的秒数（缺省与背景同拍） */
  orbitPeriod?: number;
}

/** 完成后多久整层消失（相对 ready） */
export const SPLASH_FINISH_AFTER = SPLASH_TIMING.hold + SPLASH_TIMING.fadeOut;

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
 * 双星轨道：花心为圆心、半径 34（局部单位）的圆，倾斜成扁椭圆（竖向压到 0.36），
 * 再整体转 -18°。下半圈在前（离观者近），上半圈在后。
 */
export const SPLASH_ORBIT = Object.freeze({ radius: 34, squash: 0.36, roll: -18 });

// ---- 小工具 ----
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const outCubic = (x: number) => 1 - (1 - x) ** 3;
const inOutCubic = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** 轨道上相位 phase（度）、半径 r 处的星：屏幕位置与纵深 depth（-1 后 … 1 前） */
function orbitPoint(phase: number, r: number) {
  const a = rad(phase);
  const ex = r * Math.cos(a);
  const ey = r * Math.sin(a) * SPLASH_ORBIT.squash;
  const roll = rad(SPLASH_ORBIT.roll);
  const lx = ex * Math.cos(roll) - ey * Math.sin(roll);
  const ly = ex * Math.sin(roll) + ey * Math.cos(roll);
  return {
    x: SPLASH_LAYOUT.cx + K * lx,
    y: SPLASH_LAYOUT.cy + K * ly,
    depth: Math.sin(a),
    /** 屏幕上从 12 点钟顺时针量的角度，用来判断扫过哪片瓣 */
    screenAngle: (Math.atan2(lx, -ly) * 180) / Math.PI,
  };
}

/** 星扫过之后瓣的亮度：刚扫过最亮，之后指数变暗 */
function litByStar(petalAngle: number, starDeg: number): number {
  const behind = (((starDeg - petalAngle) % 360) + 360) % 360;
  return behind < 300 ? Math.exp(-behind / 70) : 0;
}

/** 加载中字母的起伏（0..1）：两颗星相差半圈，所以花上的图案每半圈重复一次，字也按半圈一拍 */
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
  const T = SPLASH_TIMING;
  const period = options.orbitPeriod ?? SPLASH_TEMPOS.sync;
  const beat = period / 2;
  const n = WORDMARK.shapes.length;
  const appear = seg(t, T.appear[0], T.appear[1]);
  const petalLit = new Array<number>(PETAL_COUNT).fill(0);
  const stars: SplashStar[] = [];
  const letters: Array<{ opacity: number; dy: number }> = [];
  const done = readyAt !== null && t >= readyAt;
  const u = done ? t - readyAt : 0; // 收尾进行了多久

  // 双星：加载中匀速绕轨道；完成后半径收拢到 0、再额外转一圈合于花心
  const merge = done ? inOutCubic(seg(u, 0, T.merge)) : 0;
  const phase = (t / period) * 360 + 360 * merge;
  const r = SPLASH_ORBIT.radius * (1 - merge);
  if (!done || merge < 1) {
    for (const [ph, companion] of [[phase, false], [phase + 180, true]] as const) {
      const p = orbitPoint(ph, r);
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
  const bloom = done ? outCubic(seg(u, T.bloom[0], T.bloom[1])) : 0;

  // 字标
  if (!done) {
    for (let j = 0; j < n; j++) {
      const w = letterWave(t, j, n, beat);
      letters.push({ opacity: appear * (LETTER_BASE + LETTER_WAVE * w), dy: -2.5 * w });
    }
  } else {
    const c = seg(u, T.sweep[0], T.sweep[1]);
    const sweepX = lerp(L.cx, L.wordX + WORDMARK.width * L.wordScale + 40, inOutCubic(c));
    if (c > 0 && c < 1) {
      stars.push({ x: sweepX, y: L.cy - 6, opacity: 1 - seg(c, 0.85, 1), scale: 0.85, front: true, companion: false });
    }
    // ready 那一刻的起伏在 0.3s 内回落到底色，再等光掠过点亮，避免跳变
    const settle = seg(u, 0, 0.3);
    WORDMARK.shapes.forEach((shape, j) => {
      const w = letterWave(readyAt!, j, n, beat) * (1 - settle);
      const base = LETTER_BASE + LETTER_WAVE * w;
      const lit = c > 0 ? outCubic(seg(sweepX - (L.wordX + shape.cx * L.wordScale), -10, 60)) : 0;
      letters.push({ opacity: lerp(base, 1, lit), dy: lit > 0 ? 8 * (1 - lit) : -2.5 * w });
    });
  }

  const petals = MARK_GEOMETRY.petals.map((_, i) => {
    const lit = lerp(petalLit[i] ?? 0, 1, bloom);
    return { opacity: appear * (0.2 + 0.8 * lit), scale: 1 + 0.07 * lit * (1 - bloom) };
  });

  const hop = done ? seg(u, T.hop[0], T.hop[1]) : 0;
  const flash = done && u > T.merge ? Math.exp(-(u - T.merge) * 3) : 0;
  const sw = done ? seg(u, T.shock[0], T.shock[1]) : 0;
  const shock = sw > 0 && sw < 1
    ? { r: K * (6 + 60 * outCubic(sw)), opacity: 0.45 * (1 - sw), width: 3 * (1 - sw) }
    : null;
  const fade = done ? seg(u, T.hold, T.hold + T.fadeOut) : 0;

  return {
    layer: 1 - fade,
    appear,
    petals,
    hubScale: 1 + 0.6 * Math.sin(Math.PI * hop),
    glow: clamp(0.1 + 0.4 * bloom + 0.35 * flash),
    shock,
    stars,
    letters,
    finished: done && u >= SPLASH_FINISH_AFTER,
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

/** 星点的「时间」：加载完成那一下加速冲出一把再回落 */
function starTime(t: number, readyAt: number | null): number {
  if (readyAt === null || t < readyAt) return t;
  return t + 0.8 * (1 - Math.exp(-(t - readyAt) * 2));
}

/**
 * 背景星点的光迹（像素坐标，按画布实际大小算，中心在画布中心）。
 * 每颗星飘完全程的时间相同（SPLASH_TIMING.starfieldPeriod），起点相位各不相同。
 * @param scale 线宽倍率（高分屏传 devicePixelRatio × 舞台缩放）
 */
export function starfield(t: number, readyAt: number | null, width: number, height: number, scale = 1): StarStreak[] {
  const u = starTime(t, readyAt) / SPLASH_TIMING.starfieldPeriod;
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
