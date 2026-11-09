import { describe, expect, it } from 'vitest';
import { BANNER_LAYOUT, bannerSvg, markSvg, taskbarSvg, tileIconSvg, wordmarkSvg } from './svg.ts';
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

  it('桌面图标：带深色圆角磁贴', () => {
    const svg = tileIconSvg({ size: 256 });
    expect(svg).toContain(`<rect width="64" height="64" rx="14" fill="${BRAND_COLORS.tile}"/>`);
    expect(svg).toContain('width="256" height="256"');
    expect(svg).toMatchSnapshot();
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
