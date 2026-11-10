/**
 * 纯字符串版 SVG 构造器：给导出脚本、开机首帧、主进程窗口图标用。
 * React 组件另有 JSX 版，几何同源（geometry.ts / wordmark.ts）。
 */
import { MARK_CENTER, MARK_GEOMETRY, MARK_PARAMS, MARK_VIEWBOX, TASKBAR_PARAMS, fmt, markGeometry, type MarkParams } from './geometry.ts';
import { BRAND_COLORS } from './tokens.ts';
import { WORDMARK, type Wordmark } from './wordmark.ts';

export interface MarkSvgOptions {
  /** 强调色（长瓣）；缺省 var(--spica-accent, 暗色强调色) */
  accent?: string;
  /** 文字色（短瓣与轴）；缺省 currentColor */
  ink?: string;
  /** 输出边长（不写则不加 width/height，随容器） */
  size?: number;
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
export function markBody(opts: Omit<MarkSvgOptions, 'size' | 'className' | 'title'> = {}): string {
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}"${size}${cls}${attr}>${el}${markBody(opts)}</svg>`;
}

/** 写死图标的花缩到 93%，给外圈细边留出画框 */
export const FIXED_ICON_FIT = 0.93;

/**
 * 写死颜色的应用图标：安装程序、资源管理器里的 exe、卸载条目这些不能随任务栏深浅换色的位置。
 * 无底白花，外加一圈深色细边，白底和深底上都看得见。
 * 边宽按输出像素算：48px 及以下约 1px，再大按比例（size / 48）；48px 及以下用光学版几何，64px 起用原版花。
 */
export function fixedIconSvg(size: number): string {
  const params = size <= 48 ? TASKBAR_PARAMS : MARK_PARAMS;
  const { ink, rim } = BRAND_COLORS.fixedIcon;
  const rimPx = Math.max(1, size / 48);
  // 描边一半被花盖住，所以乘 2；再除掉花组和外层的放大，换回 64 画框单位
  const width = (2 * rimPx * MARK_VIEWBOX) / size / (params.scale * FIXED_ICON_FIT);
  const c = fmt(MARK_CENTER);
  const rimLayer = `<g stroke="${rim}" stroke-width="${fmt(width)}" stroke-linejoin="round">${markBody({ ink: rim, accent: rim, params })}</g>`;
  const flower = markBody({ ink, accent: ink, params });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}" width="${size}" height="${size}" aria-hidden="true"><g transform="translate(${c} ${c}) scale(${fmt(FIXED_ICON_FIT)}) translate(-${c} -${c})">${rimLayer}${flower}</g></svg>`;
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

/** 字标自身的画框：从高过大写字母的部分（ascent）一直到下伸 */
export function wordmarkViewBox(wm: Wordmark = WORDMARK): { y: number; width: number; height: number } {
  const ascent = wm.ascent ?? 0;
  return { y: -ascent, width: wm.width, height: ascent + wm.height + wm.descent };
}

/** 字标 SVG */
export function wordmarkSvg(opts: { ink?: string; height?: number; className?: string; title?: string; wordmark?: Wordmark } = {}): string {
  const wm = opts.wordmark ?? WORDMARK;
  const vb = wordmarkViewBox(wm);
  const size = opts.height ? ` width="${fmt((opts.height * vb.width) / vb.height)}" height="${opts.height}"` : '';
  const cls = opts.className ? ` class="${esc(opts.className)}"` : '';
  const { attr, el } = a11y(opts.title);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${fmt(vb.y)} ${vb.width} ${vb.height}"${size}${cls}${attr}>${el}${wordmarkBody(opts.ink, wm)}</svg>`;
}

/**
 * 横标排版：花标 64 见方在左，间距 16，字标大写高 36、在花标框里竖向居中。
 * 返回画框尺寸与字标的放置变换，React 版和字符串版共用。
 */
export function bannerLayout(wm: Wordmark = WORDMARK): Readonly<{ width: number; top: number; height: number; wordTransform: string }> {
  const gap = 16;
  const wordHeight = 36; // 大写高 = 花标框高 × 0.5625（定稿比较图都按这个比例）
  const wordScale = wordHeight / wm.height;
  const wordX = MARK_VIEWBOX + gap;
  const wordY = (MARK_VIEWBOX - wordHeight) / 2; // 大写字母在花标框里竖向居中
  // 下伸部分（p 的竖笔）超出花标框时，画框往下加高；高过大写字母的部分超出时，画框往上加高（top 为负）
  const bottom = Math.max(MARK_VIEWBOX, Math.ceil(wordY + (wm.height + wm.descent) * wordScale));
  const top = Math.min(0, Math.floor(wordY - (wm.ascent ?? 0) * wordScale));
  const width = wordX + wm.width * wordScale;
  return Object.freeze({
    width,
    /** 画框上沿的 y（通常 0） */
    top,
    /** 画框高（从 top 算起） */
    height: bottom - top,
    wordTransform: `translate(${fmt(wordX)} ${fmt(wordY)}) scale(${fmt(wordScale)})`,
  });
}

export const BANNER_LAYOUT = bannerLayout();

/** 横标 SVG：标志 + 字标；background 给了就铺底色（宣传图、文档用） */
export function bannerSvg(opts: { accent?: string; ink?: string; height?: number; background?: string | null; title?: string; wordmark?: Wordmark } = {}): string {
  const wm = opts.wordmark ?? WORDMARK;
  const L = bannerLayout(wm);
  const size = opts.height ? ` width="${fmt((opts.height * L.width) / L.height)}" height="${opts.height}"` : '';
  const bg = opts.background ? `<rect${L.top ? ` y="${fmt(L.top)}"` : ''} width="${fmt(L.width)}" height="${fmt(L.height)}" fill="${opts.background}"/>` : '';
  const { attr, el } = a11y(opts.title);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${fmt(L.top)} ${fmt(L.width)} ${fmt(L.height)}"${size}${attr}>${el}${bg}${markBody(opts)}<g transform="${L.wordTransform}">${wordmarkBody(opts.ink, wm)}</g></svg>`;
}
