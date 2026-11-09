/**
 * 开机画面「暗处亮起 · 双星环绕」的时间线（纯函数，不碰 DOM）。
 *
 * 画面是一块 1280 × 720 的舞台（React 组件按窗口等比缩放），花标 + 字标的大横标居中。
 * - 背景：星点从画面中心沿径向向外飘出，每颗星飘完全程固定 5 秒。
 * - 加载中：一蓝一白两颗星像真正的双星一样绕共同的中心（花心）转，永远一前一后、相差半圈；
 *   轨道是开普勒椭圆，近快远慢，最近点朝前。花标和字标跟双星同一个节拍呼吸、起伏，
 *   但不和星的位置一一对应（不再「星扫到哪片、哪片亮」）。
 * - 加载完成（ready）后的收尾（每一步时长都是参数 SPLASH_FINISH）：
 *   ① 扩轨：双星平滑加速，轨道放大到 1.8 倍，同时拖尾拉长；
 *   ② 大半径上再绕一圈半；③ 加速收向花心，合一消失；
 *   ④ 合一那一帧起，花标像水波一样从花心向外把实色填满（圆形遮罩扩散 + 两圈涟漪，轮廓不动）；
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
  /** ③ 收心：用时、合一那一刻双星转速是平时的几倍 */
  collapse: number;
  collapseSpeed: number;
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
  expand: 0.6,
  bigRadius: 1.8,
  bigSpeed: 3,
  bigTurns: 1.5,
  collapse: 0.8,
  collapseSpeed: 5,
  trail: 0.35,
  trailStart: 0.2,
  trailFadeIn: 0.5,
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

/** 收尾各步的起止时刻（从 ready 算起） */
export function splashSchedule(options: SplashOptions = {}): SplashSchedule {
  const F = { ...SPLASH_FINISH, ...options.finish };
  const period = options.orbitPeriod ?? SPLASH_TIMING.orbitPeriod;
  const bigStart = F.expand;
  const collapseStart = bigStart + (F.bigTurns * period) / F.bigSpeed;
  const merge = collapseStart + F.collapse;
  const fillEnd = merge + F.fill;
  const sweepStart = fillEnd + F.sweepDelay;
  const sweepEnd = sweepStart + F.sweep;
  const fadeStart = sweepEnd + F.letterGlow + F.hold;
  return { bigStart, collapseStart, merge, fillEnd, sweepStart, sweepEnd, fadeStart, end: fadeStart + F.fadeOut };
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

/** 双星转速倍率（u = ready 后秒数）：扩轨平滑加到 bigSpeed → 大半径匀速 → 收心缓入加到 collapseSpeed */
function orbitMultiplier(u: number, F: SplashFinish, S: SplashSchedule): number {
  if (u <= 0) return 1;
  if (u < S.bigStart) return 1 + (F.bigSpeed - 1) * smooth(u / F.expand);
  if (u < S.collapseStart) return F.bigSpeed;
  return F.bigSpeed + (F.collapseSpeed - F.bigSpeed) * easeIn(Math.min((u - S.collapseStart) / F.collapse, 1));
}

/** ∫0^u (倍率 - 1) du：加速带来的「额外走过的时间」 */
function orbitExtraTime(u: number, F: SplashFinish, S: SplashSchedule): number {
  if (u <= 0) return 0;
  const a = Math.min(u, S.bigStart);
  let extra = F.expand * (F.bigSpeed - 1) * smoothArea(a / F.expand);
  if (u <= S.bigStart) return extra;
  const b = Math.min(u, S.collapseStart) - S.bigStart;
  extra += b * (F.bigSpeed - 1);
  if (u <= S.collapseStart) return extra;
  const c = Math.min(u, S.merge) - S.collapseStart;
  extra += c * (F.bigSpeed - 1) + (F.collapseSpeed - F.bigSpeed) * F.collapse * easeInArea(c / F.collapse);
  if (u > S.merge) extra += (u - S.merge) * (F.collapseSpeed - 1);
  return extra;
}

/** 轨道半径倍率：扩轨平滑放大 → 大半径 → 收心缓入缩到 0 */
function radiusScale(u: number, F: SplashFinish, S: SplashSchedule): number {
  if (u <= 0) return 1;
  if (u < S.bigStart) return 1 + (F.bigRadius - 1) * smooth(u / F.expand);
  if (u < S.collapseStart) return F.bigRadius;
  return F.bigRadius * (1 - easeIn(Math.min((u - S.collapseStart) / F.collapse, 1)));
}

/** 某一时刻的速度倍率（相对平时）：双星转速、背景星点速度。给曲线图和测试用 */
export function splashSpeeds(t: number, readyAt: number | null, options: SplashOptions = {}): { orbit: number; starfield: number } {
  if (readyAt === null || t < readyAt) return { orbit: 1, starfield: 1 };
  const F = finishOf(options);
  const S = splashSchedule(options);
  const u = t - readyAt;
  const orbit = orbitMultiplier(Math.min(u, S.merge), F, S);
  const starfield = u <= S.merge
    ? 1 + (F.starPeak - 1) * easeIn(u / S.merge)
    : 1 + (F.starPeak - 1) * settleCurve(Math.min((u - S.merge) / F.starSettle, 1));
  return { orbit, starfield };
}

/** 某一时刻双星轨道半径是平时的几倍（给测试和时间表用） */
export function splashOrbitScale(t: number, readyAt: number | null, options: SplashOptions = {}): number {
  if (readyAt === null || t < readyAt) return 1;
  return radiusScale(t - readyAt, finishOf(options), splashSchedule(options));
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
  const S = splashSchedule(options);
  const beat = period / 2;
  const n = WORDMARK.shapes.length;
  const appear = seg(t, SPLASH_TIMING.appear[0], SPLASH_TIMING.appear[1]);
  const done = readyAt !== null && t >= readyAt;
  const u = done ? t - readyAt : 0;
  const depthRef = SPLASH_ORBIT.semiMajor * (1 + e);

  // 双星在时刻 tt 的位置（拖尾用同一个函数回看过去的位置）；合一之后没有
  const starsAt = (tt: number) => {
    const uu = readyAt !== null && tt >= readyAt ? tt - readyAt : 0;
    if (uu >= S.merge) return null;
    const M = (2 * Math.PI * (tt + orbitExtraTime(uu, F, S))) / period;
    const a = SPLASH_ORBIT.semiMajor * radiusScale(uu, F, S);
    const kp = keplerPosition(M, e);
    const px = a * kp.r * Math.cos(kp.angle + Math.PI / 2);
    const py = a * kp.r * Math.sin(kp.angle + Math.PI / 2);
    return [project(px, py, depthRef), project(-px, -py, depthRef)] as const;
  };

  const stars: SplashStar[] = [];
  const trails: SplashTrailDot[] = [];
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
    }
  }

  // 花标：加载中与双星同节拍呼吸（不和星的位置对应）；ready 后停在 ready 那一刻的亮度，等水波填实
  const breathT = done ? readyAt! : t;
  const petalOpacity = appear * (PETAL_BASE + PETAL_PULSE * pulse(breathT, beat));
  const petals = MARK_GEOMETRY.petals.map(() => ({ opacity: petalOpacity, scale: 1 }));

  // 水波填充：合一起，实色花标的圆形遮罩从花心扩到整朵花，带两圈涟漪
  const m = u - S.merge;
  let fill: SplashFrame['fill'] = null;
  if (done && m >= 0) {
    const radius = L.fillRadius * outCubic(seg(m, 0, F.fill));
    const ripples = [0, 0.28].map((lag) => {
      const q = seg(m, lag * F.fill, F.fill * (1 + lag));
      return { r: L.fillRadius * 1.25 * outCubic(q), opacity: q > 0 && q < 1 ? 0.55 * (1 - q) : 0 };
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
  const S = splashSchedule(options);
  const u = t - readyAt;
  const up = (F.starPeak - 1) * S.merge * easeInArea(Math.min(u / S.merge, 1));
  const down = u > S.merge ? (F.starPeak - 1) * F.starSettle * settleArea(Math.min((u - S.merge) / F.starSettle, 1)) : 0;
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
