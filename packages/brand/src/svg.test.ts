import { describe, expect, it } from 'vitest';
import { BANNER_LAYOUT, TASKBAR_FRAME_SIZES, bannerSvg, fixedIconSvg, markSvg, taskbarFrameSvg, taskbarSvg, wordmarkSvg } from './svg.ts';
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

  it('写死的应用图标：单色花、透明底，不加描边，所有尺寸都用光学版', () => {
    const { ink } = BRAND_COLORS.fixedIcon;
    for (const size of [16, 24, 48, 256]) {
      const svg = fixedIconSvg(size);
      expect(svg).not.toContain('<rect');
      expect(svg).not.toContain('stroke');
      expect(svg).not.toContain('filter');
      expect(svg).toContain(`width="${size}" height="${size}"`);
      expect(svg).toContain('scale(1.22)'); // 光学版
      expect(svg.match(/fill="([^"]+)"/g)).toEqual(Array(10).fill(`fill="${ink}"`)); // 九瓣 + 轴，一种颜色
    }
    expect(fixedIconSvg(24, '#2F7DE1')).toContain('fill="#2F7DE1"');
    expect(fixedIconSvg(256)).toMatchSnapshot();
  });

  it('任务栏图标：无底、用光学版几何', () => {
    const svg = taskbarSvg({ ink: dark.ink, accent: dark.accent });
    expect(svg).not.toContain('<rect');
    expect(svg).toContain('scale(1.22)');
    expect(svg).toContain('r="5.2"');
    expect(svg).toMatchSnapshot();
  });

  it('任务栏逐帧：按尺寸出图，花心落在像素格上，挪动不超过半像素', () => {
    expect(TASKBAR_FRAME_SIZES).toEqual(expect.arrayContaining([16, 20, 24, 30, 32, 36, 40, 48, 256]));
    for (const size of TASKBAR_FRAME_SIZES) {
      const svg = taskbarFrameSvg(size, { ink: '#fff' });
      expect(svg).toContain(`width="${size}" height="${size}"`);
      expect(svg).toContain('scale(1.22)');
      const [dx, dy] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(svg)!.slice(1).map(Number) as [number, number];
      const px = size / 64;
      expect(Math.abs(dx * px)).toBeLessThanOrEqual(0.5 + 1e-3);
      expect(Math.abs(dy * px)).toBeLessThanOrEqual(0.5 + 1e-3);
      // 花心（32, 37.65）挪完后落在像素中心或格线上
      const frac = (v: number) => Math.abs(v - Math.round(v * 2) / 2);
      expect(frac((32 + dx) * px)).toBeLessThan(2e-3);
      expect(frac((37.65 + dy) * px)).toBeLessThan(2e-3);
    }
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
