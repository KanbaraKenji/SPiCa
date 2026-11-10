/**
 * npm run brand:build —— 从几何源（src/）重新生成全部品牌成品。
 *
 * 产物：
 *   apps/desktop/resources/branding/   应用打包用（svg/、png/、spica.ico）
 *   branding/                          品牌目录里的同一套成品（svg/、png/、spica.ico）
 *
 * 位图永远从矢量重新生成，不要手工修位图。
 *
 * 栅格化用 @resvg/resvg-js：npm 上为 Windows / macOS / Linux 各平台带预编译二进制，
 * 装上即用，不需要本机编译工具链，也不需要起 Electron 或浏览器；渲染结果跨平台一致。
 */
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BANNER_LAYOUT, bannerSvg, fixedIconSvg, markSvg, taskbarSvg, wordmarkSvg } from '../src/svg.ts';
import { BRAND_COLORS } from '../src/tokens.ts';
import { buildIco } from './ico.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TARGETS = [path.join(repo, 'apps/desktop/resources/branding'), path.join(repo, 'branding')];

const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024] as const;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;
/** 窗口图标兜底位图的边长 */
const WIN_ICON_SIZE = 256;
/** 横标位图倍率（画框 × 4，64 高的横标出 256 高） */
const BANNER_SCALE = 4;

const { dark, light } = BRAND_COLORS;

/** 矢量成品：文件名 → SVG */
function vectorFiles(): Record<string, string> {
  return {
    'spica-icon.svg': fixedIconSvg(256),
    'spica-mark-dark.svg': markSvg({ ink: dark.ink, accent: dark.accent }),
    'spica-mark-light.svg': markSvg({ ink: light.ink, accent: light.accent }),
    'spica-taskbar-dark.svg': taskbarSvg({ ink: dark.ink, accent: dark.accent }),
    'spica-taskbar-light.svg': taskbarSvg({ ink: light.ink, accent: light.accent }),
    'spica-wordmark-dark.svg': wordmarkSvg({ ink: dark.ink }),
    'spica-wordmark-light.svg': wordmarkSvg({ ink: light.ink }),
    'spica-banner-dark.svg': bannerSvg({ ink: dark.ink, accent: dark.accent }),
    'spica-banner-light.svg': bannerSvg({ ink: light.ink, accent: light.accent }),
  };
}

function raster(svg: string, width: number): Uint8Array {
  return new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
}

/** 位图成品：文件名 → PNG */
function rasterFiles(): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  // 写死的应用图标：每个尺寸单独画，边宽和几何跟尺寸走
  for (const s of ICON_SIZES) out[`spica-icon-${s}.png`] = raster(fixedIconSvg(s), s);
  // 运行态窗口图标首帧兜底：无底、光学版；深色任务栏用亮花，浅色任务栏用深花
  out['spica-win-dark.png'] = raster(taskbarSvg({ ink: dark.ink, accent: dark.accent }), WIN_ICON_SIZE);
  out['spica-win-light.png'] = raster(taskbarSvg({ ink: light.ink, accent: light.accent }), WIN_ICON_SIZE);
  // 横标位图：带底色，宣传 / 文档用
  for (const [name, c] of [['dark', dark], ['light', light]] as const) {
    const svg = bannerSvg({ ink: c.ink, accent: c.accent, background: c.background });
    out[`spica-banner-${name}.png`] = raster(svg, Math.round(BANNER_LAYOUT.width * BANNER_SCALE));
  }
  return out;
}

/** 清掉旧成品（只删本脚本管的扩展名，目录里的文档等不动） */
function cleanDir(dir: string, exts: readonly string[]) {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) {
    if (exts.some((e) => f.endsWith(e))) rmSync(path.join(dir, f));
  }
}

function main() {
  const svgs = vectorFiles();
  const pngs = rasterFiles();
  const ico = buildIco(ICO_SIZES.map((size) => ({ size, png: raster(fixedIconSvg(size), size) })));

  for (const root of TARGETS) {
    cleanDir(path.join(root, 'svg'), ['.svg']);
    cleanDir(path.join(root, 'png'), ['.png']);
    cleanDir(root, ['.ico']);
    for (const [name, svg] of Object.entries(svgs)) writeFileSync(path.join(root, 'svg', name), svg + '\n');
    for (const [name, png] of Object.entries(pngs)) writeFileSync(path.join(root, 'png', name), png);
    writeFileSync(path.join(root, 'spica.ico'), ico);
    console.log(`已生成 ${path.relative(repo, root)}：${Object.keys(svgs).length} 个 SVG、${Object.keys(pngs).length} 张 PNG、spica.ico`);
  }
}

main();
