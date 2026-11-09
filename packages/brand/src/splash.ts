/**
 * 开机画面「暗处亮起 · 双星环绕」的时间线（纯函数，不碰 DOM）。
 *
 * 画面是一块 1280 × 720 的舞台（React 组件按窗口等比缩放），花标 + 字标的大横标居中。
 * - 背景：星点从画面中心沿径向向外飘出，每颗星飘完全程固定 5 秒。
 * - 加载中：一蓝一白两颗星像真正的双星一样绕共同的中心（花心）转，永远一前一后、相差半圈；
 *   轨道是开普勒椭圆，近快远慢，最近点朝前。花标和字标跟双星同一个节拍呼吸、起伏，
 *   但不和星的位置一一对应（不再「星扫到哪片、哪片亮」）。
 * - 加载完成（ready）后的收尾（每一步时长都是参数 SPLASH_FINISH）：
 *   ① 扩轨：双星平滑加速，轨道放大到 1.8 倍，拖尾拉长；② 大半径上绕约 0.94 圈；
 *   ③ 大半径段一结束，双星从当时位置沿一小段短弧直接扎进花心（不再转圈，越扎越快），合一消失；
 *   ④ 合一那一帧起，花标从花心向外把实色填满：两道细环先行、实色随后跟上（圆形遮罩，轮廓不动）；
 *   ⑤ 一道光扫过字标，经过处字由暗变亮、闪一下辉光再回稳；⑥ 停住；⑦ 整层淡出。
 * - 短版（每天第二次起）：花标和字标淡入、停住、淡出，总长约 1 秒，不放星点。见 splashBriefFrame。
 * 花瓣只动透明度和缩放，形状一笔不改。
 */
import { MARK_GEOMETRY, MARK_VIEWBOX } from './geometry.ts';
import { WORDMARK } from './wordmark.ts';

export const SPLASH_STAGE = Object.freeze({ width: 1280, height: 720 });

/** 加载中的节奏（秒） */
export const SPLASH_TIMING = Object.freeze({
  /** 背景：每颗星从中心飘到画面外的时间 */
  starfieldPeriod: 5,
  /** 双星转一圈的时间（缺省） */
  orbitPeriod: 3.5,
  /** 进场：花和字从暗处浮现 */
  appear: [0.2, 1.0] as const,
});

/** 收尾各步（秒，按顺序首尾相接；起止时刻见 splashSchedule） */
export interface SplashFinish {
  /** ① 扩轨：用时、轨道放到原来的几倍、此时双星转速是平时的几倍 */
  expand: number;
  bigRadius: number;
  bigSpeed: number;
  /** ② 大半径上再绕几圈（用时 = 圈数 × 一圈秒数 ÷ bigSpeed） */
  bigTurns: number;
  /** 大半径段结束、开始扎心时，前面那颗星在屏幕上的方位（从 12 点钟顺时针的度数；92 = 字标一侧）。alignDive 按它微调圈数 */
  diveAngle: number;
  /** 由哪颗星领头扎入（在前面、处在 diveAngle 方位）：primary = 蓝星，companion = 白色伴星 */
  diveStar: 'primary' | 'companion';
  /**
   * ③ 扎心：用时（秒）；路线的形状——沿轨道方向再走多少（平近点角，单位：圈，越大弧越长）、
   * 中途先往外甩多少（0 = 不甩，0.2 = 半径最多放大 20%）。
   * 速度按屏幕上的线速度设计：从扎入那一刻的速度起只升不降（缓入曲线），终点是起点的几倍由路线长短和用时算出
   */
  collapse: number;
  diveArc: number;
  diveSwing: number;
  /** 半径收缩的指数：2 = 先沿轨道走、最后才直冲花心；越接近 1 越早往里卷（像螺线） */
  diveCurl: number;
  /** 拖尾：收尾时光迹拖多长（秒）、从 ready 后多久开始拉长、拉长用时；加载中的短拖尾长度与浓度 */
  trail: number;
  trailStart: number;
  trailFadeIn: number;
  loadTrail: number;
  loadTrailStrength: number;
  /** 背景星点：合一时速度是平时几倍、合一后回落用时 */
  starPeak: number;
  starSettle: number;
  /** ④ 水波填充：从合一起的用时；轴弹一下的用时 */
  fill: number;
  hop: number;
  /** ⑤ 扫字：相对填充结束的开始偏移（负数 = 提前一点接上）、用时；字亮起后的辉光回稳用时 */
  sweepDelay: number;
  sweep: number;
  letterGlow: number;
  /** ⑥ 扫字结束后停多久；⑦ 淡出用时 */
  hold: number;
  fadeOut: number;
}

export const SPLASH_FINISH: Readonly<SplashFinish> = Object.freeze({
  // 顺序定死：加速扩轨（带拖尾）→ 大半径上绕约半圈 → 蓝星在前、走到字标右上方时顺弧向下扎进花心，一路加速。
  expand: 0.6,
  bigRadius: 1.8,
  bigSpeed: 3,
  bigTurns: 0.5,
  diveAngle: 72,
  diveStar: 'primary',
  collapse: 0.175,
  diveArc: 0.15,
  diveSwing: 0,
  diveCurl: 1.4,
  trail: 0.35,
  trailStart: 0,
  trailFadeIn: 0.3,
  loadTrail: 0.12,
  loadTrailStrength: 0.4,
  starPeak: 3,
  starSettle: 1.5,
  fill: 1.2,
  hop: 0.5,
  sweepDelay: -0.15,
  sweep: 0.8,
  letterGlow: 0.5,
  hold: 1.0,
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
  /** 大半径段的圈数是否按 ready 时刻微调，让扎心总从字标一侧开始（缺省 true） */
  alignDive?: boolean;
}

export interface SplashSchedule {
  /** 以下都是从 ready 起的秒数 */
  bigStart: number;
  collapseStart: number;
  merge: number;
  fillEnd: number;
  sweepStart: number;
  sweepEnd: number;
  fadeStart: number;
  end: number;
}

/**
 * 收尾各步的起止时刻（从 ready 算起）。
 * 给了 readyAt 时，大半径段的圈数会在 bigTurns 上下半圈内微调，让大半径段结束时前面那颗星正好在
 * 屏幕右侧（字标一侧），从那一侧直接扎进花心——不管加载在哪一刻完成都一样。不给 readyAt 时按 bigTurns 算。
 */
export function splashSchedule(options: SplashOptions = {}, readyAt: number | null = null): SplashSchedule {
  const F = { ...SPLASH_FINISH, ...options.finish };
  const period = options.orbitPeriod ?? SPLASH_TIMING.orbitPeriod;
  const bigStart = F.expand;
  let turns = F.bigTurns;
  if (readyAt !== null && F.bigTurns > 0 && options.alignDive !== false) {
    const k = Math.max(1, options.speedRatio ?? SPLASH_ORBIT_DEFAULTS.speedRatio);
    const e = (k - 1) / (k + 1);
    // 大半径段开始时的平近点角（单位：圈）
    const expandExtra = F.expand > 0 ? F.expand * (F.bigSpeed - 1) * smoothArea(1) : 0;
    const m0 = (readyAt + F.expand + expandExtra) / period;
    const want = diveTargetTurns(e, F.diveAngle, F.diveStar);
    const end = m0 + F.bigTurns;
    const shift = ((((want - end) % 1) + 1.5) % 1) - 0.5; // 落在 [-0.5, 0.5)
    turns = F.bigTurns + shift;
    if (turns < 0.05) turns += 1; // 圈数很少时（如 0.2 圈）不能算成负的：补一圈
  }
  const collapseStart = bigStart + (turns * period) / F.bigSpeed;
  const merge = collapseStart + F.collapse;
  const fillEnd = merge + F.fill;
  const sweepStart = fillEnd + F.sweepDelay;
  const sweepEnd = sweepStart + F.sweep;
  const fadeStart = sweepEnd + F.letterGlow + F.hold;
  return { bigStart, collapseStart, merge, fillEnd, sweepStart, sweepEnd, fadeStart, end: fadeStart + F.fadeOut };
}

/** 前面那颗星在屏幕方位 angle（度）时的平近点角（单位：圈，0..1），按偏心率与方位缓存 */
const diveTargetCache = new Map<string, number>();
function diveTargetTurns(e: number, angle: number, star: 'primary' | 'companion'): number {
  const key = `${e}|${angle}|${star}`;
  const hit = diveTargetCache.get(key);
  if (hit !== undefined) return hit;
  let best = 0;
  let bestErr = Infinity;
  for (let i = 0; i < 1440; i++) {
    const turns = i / 1440;
    const kp = keplerPosition(2 * Math.PI * turns, e);
    const px = kp.r * Math.cos(kp.angle + Math.PI / 2);
    const py = kp.r * Math.sin(kp.angle + Math.PI / 2);
    const [x, y] = star === 'primary' ? [px, py] : [-px, -py];
    {
      if (y < 0) continue; // 领头的那颗要在前面
      const p = project(x, y, 1);
      const ang = (((Math.atan2(p.x - SPLASH_LAYOUT.cx, -(p.y - SPLASH_LAYOUT.cy)) * 180) / Math.PI) + 360) % 360;
      const diff = Math.abs(ang - angle);
      const err = Math.min(diff, 360 - diff);
      if (err < bestErr) {
        bestErr = err;
        best = turns;
      }
    }
  }
  diveTargetCache.set(key, best);
  return best;
}

/** 完成后多久整层消失（相对 ready） */
export function splashFinishAfter(options: SplashOptions = {}): number {
  return splashSchedule(options).end;
}
/** 缺省设置下，完成后多久整层消失（相对 ready） */
export const SPLASH_FINISH_AFTER = splashFinishAfter();

// ---- 曲线 ----
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const smooth = (x: number) => x * x * (3 - 2 * x);
const smoothArea = (x: number) => x * x * x - (x * x * x * x) / 2;
const easeIn = (x: number) => x * x;
const easeInArea = (x: number) => (x * x * x) / 3;
const outCubic = (x: number) => 1 - (1 - x) ** 3;
const inOutCubic = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
const rad = (deg: number) => (deg * Math.PI) / 180;
const settleCurve = (x: number) => 1 - smooth(x);
const settleArea = (x: number) => x - smoothArea(x);

function finishOf(options: SplashOptions): SplashFinish {
  return { ...SPLASH_FINISH, ...options.finish };
}

/** 双星转速倍率（u = ready 后秒数，只管扎心之前）：扩轨平滑加到 bigSpeed → 大半径匀速 */
function orbitMultiplier(u: number, F: SplashFinish, S: SplashSchedule): number {
  if (u <= 0) return 1;
  if (u < S.bigStart) return 1 + (F.bigSpeed - 1) * smooth(u / F.expand);
  return F.bigSpeed;
}

/** ∫0^u (倍率 - 1) du：加速带来的「额外走过的时间」（扎心之前） */
function orbitExtraTime(u: number, F: SplashFinish, S: SplashSchedule): number {
  if (u <= 0) return 0;
  const a = Math.min(u, S.bigStart);
  const extra = F.expand > 0 ? F.expand * (F.bigSpeed - 1) * smoothArea(a / F.expand) : 0;
  if (u <= S.bigStart) return extra;
  return extra + (u - S.bigStart) * (F.bigSpeed - 1);
}

/** 轨道半径倍率（扎心之前）：扩轨平滑放大 → 大半径 */
function radiusScale(u: number, F: SplashFinish, S: SplashSchedule): number {
  if (u <= 0) return 1;
  if (u < S.bigStart) return 1 + (F.bigRadius - 1) * smooth(u / F.expand);
  return F.bigRadius;
}

interface Ctx {
  F: SplashFinish;
  S: SplashSchedule;
  period: number;
  e: number;
  readyAt: number | null;
}

function ctxOf(options: SplashOptions, readyAt: number | null): Ctx {
  const k = Math.max(1, options.speedRatio ?? SPLASH_ORBIT_DEFAULTS.speedRatio);
  return {
    F: finishOf(options),
    S: splashSchedule(options, readyAt),
    period: options.orbitPeriod ?? SPLASH_TIMING.orbitPeriod,
    e: (k - 1) / (k + 1),
    readyAt,
  };
}

/** 蓝星在轨道平面上的位置（扎心之前；伴星是它关于花心的对称点） */
function orbitPlane(tt: number, c: Ctx): { px: number; py: number } {
  const uu = c.readyAt !== null && tt >= c.readyAt ? tt - c.readyAt : 0;
  const M = (2 * Math.PI * (tt + orbitExtraTime(uu, c.F, c.S))) / c.period;
  return planeAt(M, SPLASH_ORBIT.semiMajor * radiusScale(uu, c.F, c.S), c.e);
}

function planeAt(M: number, a: number, e: number): { px: number; py: number } {
  const kp = keplerPosition(M, e);
  return { px: a * kp.r * Math.cos(kp.angle + Math.PI / 2), py: a * kp.r * Math.sin(kp.angle + Math.PI / 2) };
}

/** 平面坐标 → 屏幕像素（不含花心偏移，只用来量长度） */
function screenOf(px: number, py: number): [number, number] {
  const ey = py * SPLASH_ORBIT.squash;
  const roll = rad(SPLASH_ORBIT.roll);
  return [K * (px * Math.cos(roll) - ey * Math.sin(roll)), K * (px * Math.sin(roll) + ey * Math.cos(roll))];
}

/**
 * 扎心段：路线 shape(x)（x 0→1，从扎入点到花心）先按屏幕像素量出弧长表，
 * 再按线速度 v(y) = v0·(1 + αy + βy²)（y = τ/T）沿弧长走——速度只升不降；起点速度和加速度都接上大半径段，
 * 终点倍数 R = 1 + α + β 由弧长 L 与用时 T 算出。
 */
interface Dive {
  T: number;
  v0: number;
  R: number;
  L: number;
  /** τ（扎心后的秒数）→ 平面坐标、路线参数 x、屏幕线速度 */
  at(tau: number): { px: number; py: number; x: number; speed: number };
}

const DIVE_SAMPLES = 1200;
const diveCache = new Map<string, Dive>();
function diveOf(c: Ctx, options: SplashOptions): Dive {
  const key = JSON.stringify([options, c.readyAt]);
  const hit = diveCache.get(key);
  if (hit) return hit;
  const { F, S, period, e } = c;
  const tc = (c.readyAt ?? 0) + S.collapseStart;
  const M0 = (2 * Math.PI * (tc + orbitExtraTime(S.collapseStart, F, S))) / period;
  const a0 = SPLASH_ORBIT.semiMajor * F.bigRadius;
  const swingK = (27 / 4) * F.diveSwing;
  const shape = (x: number) => {
    const M = M0 + 2 * Math.PI * F.diveArc * (1 - (1 - x) ** 3);
    const r = (1 - x ** F.diveCurl) * (1 + swingK * x * x * (1 - x));
    return planeAt(M, a0 * r, e);
  };
  // 弧长表（屏幕像素）
  const lens = [0];
  let prev = screenOf(shape(0).px, shape(0).py);
  for (let i = 1; i <= DIVE_SAMPLES; i++) {
    const p = shape(i / DIVE_SAMPLES);
    const q = screenOf(p.px, p.py);
    lens.push(lens[i - 1]! + Math.hypot(q[0] - prev[0], q[1] - prev[1]));
    prev = q;
  }
  const L = lens[DIVE_SAMPLES]!;
  // 起点速度与加速度：接上大半径段末尾的屏幕线速度，连加速度也接上（不在接口处「停一下再加速」）
  const h = 1e-3;
  const speedAt = (tt: number) => {
    const p1 = orbitPlane(tt - h, c);
    const p2 = orbitPlane(tt, c);
    const s1 = screenOf(p1.px, p1.py);
    const s2 = screenOf(p2.px, p2.py);
    return Math.hypot(s2[0] - s1[0], s2[1] - s1[1]) / h;
  };
  const v0 = speedAt(tc);
  const acc0 = (v0 - speedAt(tc - h)) / h;
  const T = F.collapse;
  // v(y) = v0·(1 + αy + βy²)，y = τ/T；α 接上加速度（减速时取 0），β 由弧长定：L = v0·T·(1 + α/2 + β/3)
  const alpha = Math.max(0, (acc0 * T) / v0);
  const beta = 3 * (L / (v0 * T) - 1 - alpha / 2);
  const R = 1 + alpha + beta;
  const dive: Dive = {
    T,
    v0,
    R,
    L,
    at(tau) {
      const y = clamp(tau / T);
      const dist = v0 * T * (y + (alpha * y * y) / 2 + (beta * y ** 3) / 3);
      let lo = 0;
      let hi = DIVE_SAMPLES;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (lens[mid]! <= dist) lo = mid;
        else hi = mid;
      }
      const span = lens[hi]! - lens[lo]!;
      const x = (lo + (span > 0 ? clamp((dist - lens[lo]!) / span) : 0)) / DIVE_SAMPLES;
      return { ...shape(x), x, speed: v0 * (1 + alpha * y + beta * y * y) };
    },
  };
  if (diveCache.size > 64) diveCache.clear();
  diveCache.set(key, dive);
  return dive;
}

/** 扎心段的数据（起点速度、终点倍数、弧长），给对比图和测试用 */
export function splashDive(readyAt: number, options: SplashOptions = {}): { start: number; end: number; v0: number; ratio: number; length: number } {
  const c = ctxOf(options, readyAt);
  const d = diveOf(c, options);
  return { start: readyAt + c.S.collapseStart, end: readyAt + c.S.merge, v0: d.v0, ratio: d.R, length: d.L };
}

/** 某一时刻的速度倍率（相对平时）：双星转速（扎心段按屏幕线速度折算）、背景星点速度。给曲线图和测试用 */
export function splashSpeeds(t: number, readyAt: number | null, options: SplashOptions = {}): { orbit: number; starfield: number } {
  if (readyAt === null || t < readyAt) return { orbit: 1, starfield: 1 };
  const c = ctxOf(options, readyAt);
  const { F, S } = c;
  const u = t - readyAt;
  let orbit = orbitMultiplier(u, F, S);
  if (u >= S.collapseStart) {
    const d = diveOf(c, options);
    orbit = (F.bigSpeed * d.at(Math.min(u, S.merge) - S.collapseStart).speed) / d.v0;
  }
  const starfield = u <= S.merge
    ? 1 + (F.starPeak - 1) * easeIn(u / S.merge)
    : 1 + (F.starPeak - 1) * settleCurve(Math.min((u - S.merge) / F.starSettle, 1));
  return { orbit, starfield };
}

/** 某一时刻双星离花心的距离是平时轨道的几倍（给测试和时间表用） */
export function splashOrbitScale(t: number, readyAt: number | null, options: SplashOptions = {}): number {
  if (readyAt === null || t < readyAt) return 1;
  const c = ctxOf(options, readyAt);
  const u = t - readyAt;
  if (u < c.S.collapseStart) return radiusScale(u, c.F, c.S);
  if (u >= c.S.merge) return 0;
  const x = diveOf(c, options).at(u - c.S.collapseStart).x;
  const swingK = (27 / 4) * c.F.diveSwing;
  return c.F.bigRadius * (1 - x ** c.F.diveCurl) * (1 + swingK * x * x * (1 - x));
}

// ---- 版面 ----
const MARK_FRACTION = 0.36; // 花标占舞台高度
const S0 = (SPLASH_STAGE.height * MARK_FRACTION) / MARK_VIEWBOX; // 花标 64 单位 → 舞台像素
const K = S0 * MARK_GEOMETRY.params.scale; // 花瓣局部单位 → 舞台像素（含 1.15 放大）
const WORD_CAP = 96; // 字标大写高（舞台像素）
const WORD_SCALE = WORD_CAP / WORDMARK.height;
const GAP = 40;
const markW = MARK_VIEWBOX * S0;
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
  /** 水波填满整朵花需要的半径（花瓣局部单位：长瓣尖离花心 29） */
  fillRadius: 30,
});

/**
 * 双星轨道（花标局部单位）：半长轴 32 的椭圆，花心在焦点上；轨道平面倾斜，
 * 投影到屏幕上竖向压到 0.36、整体转 -18°。最近点朝前（屏幕下方、离观者近）。
 */
export const SPLASH_ORBIT = Object.freeze({ semiMajor: 32, squash: 0.36, roll: -18 });

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
  const ey = py * SPLASH_ORBIT.squash;
  const roll = rad(SPLASH_ORBIT.roll);
  const lx = px * Math.cos(roll) - ey * Math.sin(roll);
  const ly = px * Math.sin(roll) + ey * Math.cos(roll);
  return {
    x: SPLASH_LAYOUT.cx + K * lx,
    y: SPLASH_LAYOUT.cy + K * ly,
    depth: Math.max(-1, Math.min(1, py / depthRef)),
  };
}

/** 加载中的节拍（0..1）：两颗星相差半圈，所以按半圈一拍 */
function pulse(t: number, beat: number, offset = 0): number {
  return (0.5 + 0.5 * Math.cos(2 * Math.PI * (t / beat - offset))) ** 2;
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

export interface SplashTrailDot {
  x: number;
  y: number;
  opacity: number;
  /** 光点半径（舞台像素） */
  r: number;
  front: boolean;
  companion: boolean;
}

export interface SplashRibbon {
  d: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  opacity: number;
  front: boolean;
  companion: boolean;
}

export interface SplashFrame {
  /** 整层透明度（淡出时 1 → 0） */
  layer: number;
  /** 进场透明度 */
  appear: number;
  petals: ReadonlyArray<{ opacity: number; scale: number }>;
  /** 轴的透明度与缩放 */
  hubOpacity: number;
  hubScale: number;
  /** 水波填充：实色花标的圆形遮罩半径（花瓣局部单位）与涟漪；null = 不画实色层 */
  fill: { radius: number; ripples: ReadonlyArray<{ r: number; opacity: number }> } | null;
  /** 花心光晕强度 0..1（浅色主题不画） */
  glow: number;
  /** 双星与扫字的光 */
  stars: readonly SplashStar[];
  /** 双星拖尾的光点 */
  trails: readonly SplashTrailDot[];
  /** 双星拖尾的连续光带（每颗星按在花前 / 花后切成一两段）：轮廓路径、渐隐方向（头 → 尾）、头部透明度 */
  ribbons: readonly SplashRibbon[];
  /** 字母：透明度、上下位移（舞台像素）、辉光 0..1 */
  letters: ReadonlyArray<{ opacity: number; dy: number; glow: number }>;
  /** 收尾结束、可以移除 */
  finished: boolean;
}

const PETAL_BASE = 0.3;
const PETAL_PULSE = 0.22;
const HUB_BASE = 0.42;
const HUB_PULSE = 0.1;
const LETTER_BASE = 0.22;
const LETTER_WAVE = 0.3;
/** 每颗星拖尾的光点数 */
export const SPLASH_TRAIL_DOTS = 14;
/** 光带每颗星取样的点数 */
const RIBBON_SAMPLES = 32;
/** 每颗星最多切成几段光带（花前 / 花后来回切换） */
export const SPLASH_RIBBON_SLOTS = 4;

type Pt = { x: number; y: number; depth: number };

/** 一串点（头在前）→ 两侧按半宽外扩、尾部收尖的轮廓 */
function ribbonPath(pts: readonly Pt[], half: readonly number[]): string {
  const left: string[] = [];
  const right: string[] = [];
  for (let j = 0; j < pts.length; j++) {
    const a = pts[Math.max(0, j - 1)]!;
    const b = pts[Math.min(pts.length - 1, j + 1)]!;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const w = half[j]!;
    const p = pts[j]!;
    left.push(`${(p.x - dy * w).toFixed(2)} ${(p.y + dx * w).toFixed(2)}`);
    right.push(`${(p.x + dy * w).toFixed(2)} ${(p.y - dx * w).toFixed(2)}`);
  }
  return `M${left.join('L')}L${right.reverse().join('L')}Z`;
}

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
  const S = splashSchedule(options, readyAt);
  const beat = period / 2;
  const n = WORDMARK.shapes.length;
  const appear = seg(t, SPLASH_TIMING.appear[0], SPLASH_TIMING.appear[1]);
  const done = readyAt !== null && t >= readyAt;
  const u = done ? t - readyAt : 0;
  const depthRef = SPLASH_ORBIT.semiMajor * (1 + e);

  // 双星在时刻 tt 的位置（拖尾用同一个函数回看过去的位置）；合一之后没有
  const ctx: Ctx = { F, S, period, e, readyAt };
  const starsAt = (tt: number) => {
    const uu = readyAt !== null && tt >= readyAt ? tt - readyAt : 0;
    if (uu >= S.merge) return null;
    const { px, py } = uu >= S.collapseStart ? diveOf(ctx, options).at(uu - S.collapseStart) : orbitPlane(tt, ctx);
    return [project(px, py, depthRef), project(-px, -py, depthRef)] as const;
  };

  const stars: SplashStar[] = [];
  const trails: SplashTrailDot[] = [];
  const ribbons: SplashRibbon[] = [];
  const pair = starsAt(t);
  if (pair) {
    pair.forEach((p, i) => {
      stars.push({
        x: p.x,
        y: p.y,
        opacity: (done ? 1 : appear) * (0.6 + 0.4 * p.depth),
        scale: 1 + 0.35 * p.depth,
        front: p.depth >= 0,
        companion: i === 1,
      });
    });
    // 拖尾：加载中短而淡；收尾开始一会儿后拉长、变浓。沿过去一小段时间的轨迹画一串渐隐的光点
    const grow = done ? seg(u, F.trailStart, F.trailStart + F.trailFadeIn) : 0;
    const trailLen = lerp(F.loadTrail, F.trail, grow);
    const trailOn = appear * lerp(F.loadTrailStrength, 1, grow);
    if (trailOn > 0 && trailLen > 0) {
      for (let j = 1; j <= SPLASH_TRAIL_DOTS; j++) {
        const back = starsAt(t - (j / SPLASH_TRAIL_DOTS) * trailLen);
        if (!back) continue;
        const fadeK = (1 - j / (SPLASH_TRAIL_DOTS + 1)) ** 1.5;
        back.forEach((p, i) => {
          trails.push({
            x: p.x,
            y: p.y,
            opacity: trailOn * fadeK * 0.55 * (0.6 + 0.4 * p.depth),
            r: 5.5 * (1 + 0.35 * p.depth) * (0.35 + 0.65 * fadeK),
            front: p.depth >= 0,
            companion: i === 1,
          });
        });
      }
      // 光带：同一段时间按更密的取样连成一条，头宽尾尖，越快拉得越长
      const lines: Pt[][] = [[pair[0]], [pair[1]]];
      for (let j = 1; j <= RIBBON_SAMPLES; j++) {
        const back = starsAt(t - (j / RIBBON_SAMPLES) * trailLen);
        if (!back) break;
        lines[0]!.push(back[0]);
        lines[1]!.push(back[1]);
      }
      lines.forEach((line, i) => {
        if (line.length < 3) return;
        const n = line.length - 1;
        const half = line.map((p, j) => 3.4 * (1 + 0.35 * p.depth) * (1 - j / n) ** 0.8);
        // 按在花前 / 花后切段（相邻两段共用切点，不留缝）
        let start = 0;
        for (let j = 1; j <= n; j++) {
          const split = j === n || line[j]!.depth >= 0 !== line[start]!.depth >= 0;
          if (!split) continue;
          const end = j;
          const seg = line.slice(start, end + 1);
          if (seg.length >= 2) {
            const head = seg[0]!;
            const tail = line[n]!;
            ribbons.push({
              d: ribbonPath(seg, half.slice(start, end + 1)),
              // 渐隐方向按整条光带的头尾，切段后颜色仍连贯
              x1: line[0]!.x,
              y1: line[0]!.y,
              x2: tail.x,
              y2: tail.y,
              opacity: trailOn * 0.6 * (0.6 + 0.4 * head.depth),
              front: head.depth >= 0,
              companion: i === 1,
            });
          }
          start = end;
        }
      });
    }
  }

  // 花标：加载中与双星同节拍呼吸（不和星的位置对应）；ready 后停在 ready 那一刻的亮度，等水波填实
  const breathT = done ? readyAt! : t;
  const petalOpacity = appear * (PETAL_BASE + PETAL_PULSE * pulse(breathT, beat));
  const petals = MARK_GEOMETRY.petals.map(() => ({ opacity: petalOpacity, scale: 1 }));

  // 填充（定稿 C「细环先行」）：合一起，两道很细的环先扩出去，实色花标的圆形遮罩随后跟上
  const m = u - S.merge;
  let fill: SplashFrame['fill'] = null;
  if (done && m >= 0) {
    const radius = L.fillRadius * outCubic(seg(m, 0.1 * F.fill, F.fill));
    const ripples = [0, 0.14].map((lag) => {
      const q = seg(m, lag * F.fill, (lag + 0.7) * F.fill);
      return { r: L.fillRadius * 1.15 * outCubic(q), opacity: q > 0 && q < 1 ? 0.7 * (1 - q) : 0 };
    });
    fill = { radius, ripples };
  }
  const hop = done && m >= 0 ? seg(m, 0, F.hop) : 0;

  // 字标
  const letters: Array<{ opacity: number; dy: number; glow: number }> = [];
  const sweepC = done ? seg(u, S.sweepStart, S.sweepEnd) : 0;
  const wordEnd = L.wordX + WORDMARK.width * L.wordScale;
  const sweepFrom = L.wordX - 40;
  const sweepTo = wordEnd + 60;
  const sweepX = lerp(sweepFrom, sweepTo, inOutCubic(sweepC));
  const pxPerSec = (sweepTo - sweepFrom) / F.sweep;
  const glowFade = 1 - (done ? seg(u, S.sweepEnd, S.sweepEnd + F.letterGlow) : 0);
  WORDMARK.shapes.forEach((shape, j) => {
    const wave = pulse(breathT, beat, j / n);
    if (!done) {
      letters.push({ opacity: appear * (LETTER_BASE + LETTER_WAVE * wave), dy: -2.5 * wave, glow: 0 });
      return;
    }
    // ready 后：起伏 0.3s 内回落到底色；光扫过字母中心时字亮满，并闪一下辉光再回稳
    const settle = seg(u, 0, 0.3);
    const rest = LETTER_BASE + LETTER_WAVE * wave * (1 - settle);
    const passed = sweepC > 0 ? sweepX - (L.wordX + shape.cx * L.wordScale) : -Infinity;
    const lit = outCubic(clamp((passed + 30) / 90));
    const since = passed > 0 ? passed / pxPerSec : -1;
    const glow = since >= 0 ? Math.exp(-since / (F.letterGlow / 2.5)) * glowFade : 0;
    letters.push({ opacity: lerp(rest, 1, lit), dy: lit > 0 ? 6 * (1 - lit) : -2.5 * wave * (1 - settle), glow: clamp(glow) });
  });
  if (done && sweepC > 0 && sweepC < 1) {
    stars.push({ x: sweepX, y: L.cy - 4, opacity: 1 - seg(sweepC, 0.85, 1), scale: 1.25, front: true, companion: false });
  }

  const fade = done ? seg(u, S.fadeStart, S.end) : 0;
  const fillW = fill ? fill.radius / L.fillRadius : 0;

  // 轴心：加载中半透明、随呼吸微变；合心那一刻起 0.25 秒变实
  const hubLoad = HUB_BASE + HUB_PULSE * pulse(breathT, beat);
  const hubOpacity = appear * (done && m >= 0 ? lerp(hubLoad, 1, outCubic(seg(m, 0, 0.25))) : hubLoad);

  return {
    layer: 1 - fade,
    appear,
    petals,
    hubOpacity,
    hubScale: 1 + 0.6 * Math.sin(Math.PI * hop),
    fill,
    glow: clamp(0.12 + 0.4 * fillW),
    stars,
    trails,
    ribbons,
    letters,
    finished: done && u >= S.end,
  };
}

/** 减弱动效时的静态画面：完整横标，不放星点 */
export function splashStaticFrame(): SplashFrame {
  return {
    layer: 1,
    appear: 1,
    petals: MARK_GEOMETRY.petals.map(() => ({ opacity: 1, scale: 1 })),
    hubOpacity: 1,
    hubScale: 1,
    fill: null,
    glow: 0.3,
    stars: [],
    trails: [],
    ribbons: [],
    letters: WORDMARK.shapes.map(() => ({ opacity: 1, dy: 0, glow: 0 })),
    finished: false,
  };
}

/** 短版时长：淡入、停住、淡出（秒），合计 1 秒 */
export const SPLASH_BRIEF = Object.freeze({ fadeIn: 0.3, hold: 0.4, fadeOut: 0.3 });

/**
 * 短版（每天第二次打开起）：完整横标淡入、停住、淡出，总长 1 秒，不放星点。
 * 1 秒到了还没 ready 就停在完整横标上等 ready，ready 后再淡出。
 */
export function splashBriefFrame(t: number, readyAt: number | null): SplashFrame {
  const B = SPLASH_BRIEF;
  const fadeFrom = readyAt === null ? Infinity : Math.max(B.fadeIn + B.hold, readyAt);
  const inA = seg(t, 0, B.fadeIn);
  const out = Number.isFinite(fadeFrom) ? seg(t, fadeFrom, fadeFrom + B.fadeOut) : 0;
  return { ...splashStaticFrame(), layer: inA * (1 - out), finished: Number.isFinite(fadeFrom) && t >= fadeFrom + B.fadeOut };
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

/** 星点的「时间」：ready 后缓入加速到合一时的 starPeak 倍，合一后平滑回落（速度连续，没有台阶） */
function starTime(t: number, readyAt: number | null, options: SplashOptions = {}): number {
  if (readyAt === null || t < readyAt) return t;
  const F = finishOf(options);
  const S = splashSchedule(options, readyAt);
  const u = t - readyAt;
  const up = (F.starPeak - 1) * S.merge * easeInArea(Math.min(u / S.merge, 1));
  const down = u > S.merge ? (F.starPeak - 1) * F.starSettle * settleArea(Math.min((u - S.merge) / F.starSettle, 1)) : 0;
  return t + up + down;
}

/**
 * 背景星点的光迹（像素坐标，按画布实际大小算）。星点从窗口正中央向外放射（透视点在窗口中心，不是花心）；
 * 穿过花标区域时被花标挡住（花标在星点画布之上）。
 * 每颗星飘完全程的时间相同（SPLASH_TIMING.starfieldPeriod），起点相位各不相同。
 * @param scale 线宽倍率（高分屏传 devicePixelRatio × 舞台缩放）
 * @param origin 星点飞出的原点（缺省画布中心，组件和视频都用缺省）
 */
export function starfield(
  t: number,
  readyAt: number | null,
  width: number,
  height: number,
  scale = 1,
  options: SplashOptions = {},
  origin: { x: number; y: number } = { x: width / 2, y: height / 2 },
): StarStreak[] {
  const u = starTime(t, readyAt, options) / SPLASH_TIMING.starfieldPeriod;
  const fadeIn = seg(t, 0, 0.8);
  const cx = origin.x;
  const cy = origin.y;
  // 飞到离原点最远的那个角之外才算出画面
  const rMax = Math.max(Math.hypot(cx, cy), Math.hypot(width - cx, cy), Math.hypot(cx, height - cy), Math.hypot(width - cx, height - cy));
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
