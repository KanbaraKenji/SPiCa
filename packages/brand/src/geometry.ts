/**
 * Spica 花标「九芒」的几何单一事实源。
 *
 * 一朵九片瓣的花：三片长瓣（12 / 4 / 8 点钟）用强调色，六片短瓣与中心的轴用文字色。
 * 所有渲染方（React 组件、开机画面、图标导出脚本）都从这里取数字，不许各自复刻。
 *
 * 坐标系：viewBox 0 0 64 64。每片瓣先在「基座 (32,27) 朝上」的局部坐标里画出，
 * 再绕 (32,32) 旋转 k × 40°；整组放大 scale 倍、下移 dy，让花在画框里视觉居中。
 */

export const MARK_VIEWBOX = 64;
/** 局部坐标里的花心（瓣绕它旋转） */
export const MARK_CENTER = 32;
/** 瓣的基座 y（局部坐标） */
export const PETAL_BASE_Y = 27;
export const PETAL_COUNT = 9;
export const PETAL_STEP_DEG = 40;

export interface MarkParams {
  /** 整组放大倍率 */
  scale: number;
  /** 整组在画框里的下移量（视觉居中） */
  dy: number;
  /** 长瓣长度 / 宽度（局部坐标单位） */
  longLength: number;
  longWidth: number;
  /** 短瓣长度 / 宽度 */
  shortLength: number;
  shortWidth: number;
  /** 轴（中心实心圆）半径 */
  hubRadius: number;
}

/** 应用内标志的定稿参数 */
export const MARK_PARAMS: Readonly<MarkParams> = Object.freeze({
  scale: 1.15,
  dy: 5,
  longLength: 24,
  longWidth: 4.2,
  shortLength: 16,
  shortWidth: 3.4,
  hubRadius: 4.5,
});

/**
 * 任务栏光学版：同一朵花，只在导出的窗口图标上放大、加粗，
 * 让 24px 任务栏里的有色像素占比从约 23% 提到约 33%。应用内的花不用它。
 */
export const TASKBAR_PARAMS: Readonly<MarkParams> = Object.freeze({
  scale: 1.22,
  dy: 5.65,
  longLength: 24,
  longWidth: 5.6,
  shortLength: 16,
  shortWidth: 4.6,
  hubRadius: 5.2,
});

/** 数字转字符串：最多 4 位小数，去掉尾随 0，避免浮点噪声进 SVG */
export function fmt(n: number): string {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
}

/** 一片瓣：基座 (32,27) 朝上，两条三次曲线围成的收尖叶形 */
export function petalPath(length: number, width: number): string {
  const c = MARK_CENTER;
  const y0 = PETAL_BASE_Y;
  const y1 = y0 - length;
  const ym = y0 - length * 0.55;
  const yt = y1 + length * 0.35;
  return (
    `M${fmt(c)} ${fmt(y0)}` +
    `C${fmt(c + width)} ${fmt(ym)} ${fmt(c + width * 1.1)} ${fmt(yt)} ${fmt(c)} ${fmt(y1)}` +
    `C${fmt(c - width * 1.1)} ${fmt(yt)} ${fmt(c - width)} ${fmt(ym)} ${fmt(c)} ${fmt(y0)}Z`
  );
}

/** 四角星屑：凹边细长，k 为凹陷系数 */
export function sparklePath(cx: number, cy: number, r: number, k = 0.2): string {
  const c = r * k;
  const p = (x: number, y: number) => `${fmt(x)} ${fmt(y)}`;
  return (
    `M${p(cx, cy - r)}` +
    `C${p(cx, cy - c)} ${p(cx + c, cy)} ${p(cx + r, cy)}` +
    `C${p(cx + c, cy)} ${p(cx, cy + c)} ${p(cx, cy + r)}` +
    `C${p(cx, cy + c)} ${p(cx - c, cy)} ${p(cx - r, cy)}` +
    `C${p(cx - c, cy)} ${p(cx, cy - c)} ${p(cx, cy - r)}Z`
  );
}

export interface Petal {
  /** 序号 0–8，顺时针，0 在 12 点钟 */
  index: number;
  /** 是否长瓣（强调色） */
  long: boolean;
  /** 绕花心的旋转角（度） */
  angle: number;
  /** 长瓣在三片中的序号 0–2；短瓣为 -1 */
  longIndex: number;
  /** 开机飞入的起点偏移（局部坐标单位）与起始旋转（度） */
  flyDx: number;
  flyDy: number;
  flyRotate: number;
  /** 常驻「工作中」星闪的周期（秒），各瓣错开 */
  twinkle: number;
  /** 路径 d（未旋转） */
  d: string;
}

export interface MarkGeometry {
  params: Readonly<MarkParams>;
  petals: readonly Petal[];
  /** 瓣组外层变换（含下移与放大） */
  groupTransform: string;
  /** 花心在画框里的坐标 */
  cx: number;
  cy: number;
  /** 花在画框里的上下左右极限，用于检查不出框 */
  bounds: { top: number; bottom: number; left: number; right: number };
}

function buildPetals(p: Readonly<MarkParams>): readonly Petal[] {
  return Array.from({ length: PETAL_COUNT }, (_, k) => {
    const long = k % 3 === 0;
    const rad = (k * PETAL_STEP_DEG * Math.PI) / 180;
    const dist = 34 + ((k * 7) % 12);
    return Object.freeze({
      index: k,
      long,
      angle: k * PETAL_STEP_DEG,
      longIndex: long ? k / 3 : -1,
      flyDx: Number((Math.sin(rad) * dist).toFixed(1)),
      flyDy: Number((-Math.cos(rad) * dist).toFixed(1)),
      flyRotate: ((k * 137) % 180) - 90,
      twinkle: Number((5.3 + ((k * 1.7) % 4.2)).toFixed(1)),
      d: long ? petalPath(p.longLength, p.longWidth) : petalPath(p.shortLength, p.shortWidth),
    });
  });
}

/** 由参数算整套几何（应用内用 MARK_GEOMETRY；任务栏光学版传 TASKBAR_PARAMS） */
export function markGeometry(params: Readonly<MarkParams> = MARK_PARAMS): MarkGeometry {
  const c = MARK_CENTER;
  const cy = c + params.dy;
  const longR = (c - (PETAL_BASE_Y - params.longLength)) * params.scale;
  const shortR = (c - (PETAL_BASE_Y - params.shortLength)) * params.scale;
  const sin60 = Math.sin(Math.PI / 3);
  return {
    params,
    petals: buildPetals(params),
    groupTransform: `translate(${fmt(c)} ${fmt(cy)}) scale(${fmt(params.scale)}) translate(-${fmt(c)} -${fmt(c)})`,
    cx: c,
    cy,
    bounds: {
      top: cy - longR,
      // 最低点是 160° / 200° 两片短瓣的尖
      bottom: cy + shortR * Math.cos(Math.PI / 9),
      left: c - longR * sin60,
      right: c + longR * sin60,
    },
  };
}

export const MARK_GEOMETRY: MarkGeometry = markGeometry();

/** 星屑落点（相对花心，局部坐标单位）：开机与「思考中」炸开时飞出的十枚 */
export const SPARKLES: ReadonlyArray<readonly [number, number]> = [
  [-26, -18], [22, -26], [30, 10], [-30, 14], [8, 30], [-12, -32], [34, -6], [-34, -4], [16, 24], [-20, 28],
];

/** 彩蛋：点击标志达到这个次数后，长瓣常驻 accent lock 颜色 */
export const ACCENT_LOCK_CLICKS = 39;
