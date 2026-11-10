import { describe, expect, it } from 'vitest';
import { BANNER_LAYOUT, bannerSvg, fixedIconSvg, markSvg, taskbarSvg, wordmarkSvg } from './svg.ts';
import { BRAND_COLORS } from './tokens.ts';

const dark = BRAND_COLORS.dark;

describe('SVG 构造器', () => {
  it('花标：缺省短瓣与轴用 currentColor，长瓣用 --spica-accent', () => {
    const svg = markSvg();
    expect(svg.match(/fill="currentColor"/g)).toHaveLength(7); // 六片短瓣 + 轴
    expect(svg.match(/var\(--spica-accent, #62A9FF\)/g)).toHaveLength(3);
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toMatchSnapshot();
  });

  it('花标：给了 title 就是可读的图片', () => {
    const svg = markSvg({ title: 'Spica <home>' });
    expect(svg).toContain('role="img"');
    expect(svg).toContain('<title>Spica &lt;home&gt;</title>');
  });

  it('写死的应用图标：无底白花加深色细边，小尺寸用光学版', () => {
    const { ink, rim } = BRAND_COLORS.fixedIcon;
    const small = fixedIconSvg(24);
    expect(small).not.toContain('<rect');
    expect(small).toContain('width="24" height="24"');
    expect(small).toContain('scale(1.22)'); // 光学版
    expect(small.match(new RegExp(`fill="${ink}"`, 'g'))).toHaveLength(10); // 九瓣 + 轴
    expect(small.match(new RegExp(`fill="${rim}"`, 'g'))).toHaveLength(10); // 细边那层
    expect(small).toContain(`stroke="${rim}"`);
    const big = fixedIconSvg(256);
    expect(big).toContain('scale(1.15)'); // 原版花
    expect(big).toMatchSnapshot();
  });

  it('写死的应用图标：边宽按输出像素算，48px 及以下约 1px', () => {
    const strokeIn = (svg: string) => Number(/stroke-width="([\d.]+)"/.exec(svg)?.[1]);
    const px = (size: number, scale: number) => (strokeIn(fixedIconSvg(size)) / 2) * scale * 0.93 * (size / 64);
    expect(px(16, 1.22)).toBeCloseTo(1, 2);
    expect(px(48, 1.22)).toBeCloseTo(1, 2);
    expect(px(256, 1.15)).toBeCloseTo(256 / 48, 2);
  });

  it('任务栏图标：无底、用光学版几何', () => {
    const svg = taskbarSvg({ ink: dark.ink, accent: dark.accent });
    expect(svg).not.toContain('<rect');
    expect(svg).toContain('scale(1.22)');
    expect(svg).toContain('r="5.2"');
    expect(svg).toMatchSnapshot();
  });

  it('任务栏图标：逐瓣颜色盖过长短瓣规则', () => {
    const fills = Array.from({ length: 9 }, (_, i) => `#00000${i}`);
    const svg = taskbarSvg({ ink: '#fff', accent: '#f00', petalFills: fills, hubFill: '#abc' });
    for (const f of fills) expect(svg).toContain(`fill="${f}"`);
    expect(svg).toContain('fill="#abc"');
    expect(svg).not.toContain('fill="#f00"');
  });

  it('字标与横标', () => {
    expect(wordmarkSvg({ ink: dark.ink, height: 40 })).toMatchSnapshot();
    const banner = bannerSvg({ ink: dark.ink, accent: dark.accent, background: dark.background, height: 64 });
    expect(banner).toContain(`viewBox="0 0 ${BANNER_LAYOUT.width} 64"`);
    expect(banner).toMatchSnapshot();
  });
});
