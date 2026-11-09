/**
 * 纯字符串版 SVG 构造器：给导出脚本、开机首帧、主进程窗口图标用。
 * React 组件另有 JSX 版，几何同源（geometry.ts / wordmark.ts）。
 */
import { MARK_CENTER, MARK_GEOMETRY, MARK_VIEWBOX, TASKBAR_PARAMS, fmt, markGeometry, type MarkParams } from './geometry.ts';
import { BRAND_COLORS } from './tokens.ts';
import { WORDMARK, type Wordmark } from './wordmark.ts';

export interface MarkSvgOptions {
  /** 强调色（长瓣）；缺省 var(--spica-accent, 暗色强调色) */
  accent?: string;
  /** 文字色（短瓣与轴）；缺省 currentColor */
  ink?: string;
  /** 输出边长（不写则不加 width/height，随容器） */
  size?: number;
  /** 圆角磁贴底（桌面图标用；任务栏图标不加底） */
  tile?: { fill: string; radius?: number } | null;
  /** 几何参数（缺省应用内定稿；任务栏光学版传 TASKBAR_PARAMS） */
  params?: Readonly<MarkParams>;
  /** 逐瓣颜色（9 个，12 点钟起顺时针）；给了就盖过 accent / ink 的长短瓣规则 */
  petalFills?: readonly string[];
  /** 轴的颜色（缺省 ink） */
  hubFill?: string;
  className?: string;
  /** 无障碍名称；不给则 aria-hidden */
  title?: string;
}

const DEFAULT_ACCENT = `var(--spica-accent, ${BRAND_COLORS.dark.accent})`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function a11y(title: string | undefined): { attr: string; el: string } {
  return title
    ? { attr: ' role="img"', el: `<title>${esc(title)}</title>` }
    : { attr: ' aria-hidden="true"', el: '' };
}

/** 花（不含外层 svg）：瓣组 + 轴，坐标在 64 画框里 */
export function markBody(opts: Omit<MarkSvgOptions, 'size' | 'tile' | 'className' | 'title'> = {}): string {
  const ink = opts.ink ?? 'currentColor';
  const accent = opts.accent ?? DEFAULT_ACCENT;
  const geo = opts.params ? markGeometry(opts.params) : MARK_GEOMETRY;
  const c = fmt(MARK_CENTER);
  const petals = geo.petals
    .map((p) => `<path fill="${opts.petalFills?.[p.index] ?? (p.long ? accent : ink)}" transform="rotate(${p.angle} ${c} ${c})" d="${p.d}"/>`)
    .join('');
  return `<g transform="${geo.groupTransform}">${petals}<circle cx="${c}" cy="${c}" r="${fmt(geo.params.hubRadius)}" fill="${opts.hubFill ?? ink}"/></g>`;
}

/** 花标 SVG */
export function markSvg(opts: MarkSvgOptions = {}): string {
  const size = opts.size ? ` width="${opts.size}" height="${opts.size}"` : '';
  const cls = opts.className ? ` class="${esc(opts.className)}"` : '';
  const { attr, el } = a11y(opts.title);
  const tile = opts.tile
    ? `<rect width="${MARK_VIEWBOX}" height="${MARK_VIEWBOX}" rx="${fmt(opts.tile.radius ?? BRAND_COLORS.tileRadius)}" fill="${opts.tile.fill}"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}"${size}${cls}${attr}>${el}${tile}${markBody(opts)}</svg>`;
}

/** 桌面图标：深色圆角磁贴 + 暗色版的花 */
export function tileIconSvg(opts: { size?: number; accent?: string; ink?: string; tile?: string } = {}): string {
  return markSvg({
    size: opts.size,
    accent: opts.accent ?? BRAND_COLORS.dark.accent,
    ink: opts.ink ?? BRAND_COLORS.dark.ink,
    tile: { fill: opts.tile ?? BRAND_COLORS.tile },
  });
}

/** 任务栏 / 窗口图标：无底、光学版几何 */
export function taskbarSvg(colors: { ink: string; accent: string; size?: number; petalFills?: readonly string[]; hubFill?: string }): string {
  return markSvg({ ...colors, params: TASKBAR_PARAMS });
}

/** 字标（不含外层 svg），坐标在字标自身画框里 */
export function wordmarkBody(ink = 'currentColor', wm: Wordmark = WORDMARK): string {
  return wm.shapes
    .map((s) =>
      s.kind === 'fill'
        ? `<path fill="${ink}"${s.evenOdd ? ' fill-rule="evenodd"' : ''} d="${s.d}"/>`
        : `<path fill="none" stroke="${ink}" stroke-width="${fmt(s.strokeWidth ?? 1)}" stroke-linecap="square" stroke-linejoin="miter" d="${s.d}"/>`,
    )
    .join('');
}

/** 字标 SVG */
export function wordmarkSvg(opts: { ink?: string; height?: number; className?: string; title?: string } = {}): string {
  const wm = WORDMARK;
  const fullH = wm.height + wm.descent;
  const size = opts.height ? ` width="${fmt((opts.height * wm.width) / fullH)}" height="${opts.height}"` : '';
  const cls = opts.className ? ` class="${esc(opts.className)}"` : '';
  const { attr, el } = a11y(opts.title);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${wm.width} ${fullH}"${size}${cls}${attr}>${el}${wordmarkBody(opts.ink)}</svg>`;
}

/**
 * 横标排版：花标 64 见方在左，间距 16，字标大写高 36、在花标框里竖向居中。
 * 返回画框尺寸与字标的放置变换，React 版和字符串版共用。
 */
export const BANNER_LAYOUT = (() => {
  const gap = 16;
  const wordHeight = 36; // 大写高 = 花标框高 × 0.5625（定稿比较图都按这个比例）
  const wordScale = wordHeight / WORDMARK.height;
  const wordX = MARK_VIEWBOX + gap;
  const wordY = (MARK_VIEWBOX - wordHeight) / 2; // 大写字母在花标框里竖向居中
  // 下伸部分（p 的竖笔）超出花标框时，画框往下加高
  const height = Math.max(MARK_VIEWBOX, Math.ceil(wordY + (WORDMARK.height + WORDMARK.descent) * wordScale));
  const width = wordX + WORDMARK.width * wordScale;
  return Object.freeze({
    width,
    height,
    wordTransform: `translate(${fmt(wordX)} ${fmt(wordY)}) scale(${fmt(wordScale)})`,
  });
})();

/** 横标 SVG：标志 + 字标；background 给了就铺底色（宣传图、文档用） */
export function bannerSvg(opts: { accent?: string; ink?: string; height?: number; background?: string | null; title?: string } = {}): string {
  const L = BANNER_LAYOUT;
  const size = opts.height ? ` width="${fmt((opts.height * L.width) / L.height)}" height="${opts.height}"` : '';
  const bg = opts.background ? `<rect width="${fmt(L.width)}" height="${fmt(L.height)}" fill="${opts.background}"/>` : '';
  const { attr, el } = a11y(opts.title);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(L.width)} ${fmt(L.height)}"${size}${attr}>${el}${bg}${markBody(opts)}<g transform="${L.wordTransform}">${wordmarkBody(opts.ink)}</g></svg>`;
}
