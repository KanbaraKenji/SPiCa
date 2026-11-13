/**
 * 品牌颜色 token。
 *
 * 应用内的标志不写死颜色：短瓣与轴用 currentColor（跟文字色走），
 * 长瓣用 CSS 变量 --spica-accent（跟皮肤强调色走）。下面的值只给导出的成品图标、
 * 横标位图和变量缺省时兜底用。
 */

export interface ThemeColors {
  /** 文字色：短瓣、轴、字标 */
  ink: string;
  /** 强调色：三片长瓣 */
  accent: string;
  /** 横标位图的底色 */
  background: string;
}

const LIGHT_INK = '#0F172A';
const ACCENT_LOCK = '#39C5BB';

export const BRAND_COLORS = Object.freeze({
  dark: Object.freeze<ThemeColors>({ ink: '#F1F5F9', accent: '#62A9FF', background: '#0F1522' }),
  light: Object.freeze<ThemeColors>({ ink: LIGHT_INK, accent: '#2F7DE1', background: '#F8FAFC' }),
  /** The app icon with fixed colours (installer, exe, uninstall entry, shortcuts): a white flower with a dark rim, seen on light and dark grounds. */
  fixedIcon: Object.freeze({ ink: '#F8FAFC', rim: LIGHT_INK }),
  /** accent lock：彩蛋解锁后长瓣常驻的颜色 */
  accentLock: ACCENT_LOCK,
});

/** 页面上用到的 CSS 变量名 */
export const CSS_VARS = Object.freeze({
  /** 强调色（任意 CSS 颜色值） */
  accent: '--spica-accent',
  /** accent lock 颜色 */
  accentLock: '--spica-accent-lock',
});
