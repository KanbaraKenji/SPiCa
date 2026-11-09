import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SpicaMark } from './SpicaMark.tsx';
import { SpicaBanner, SpicaWordmark } from './SpicaWordmark.tsx';
import { MARK_GEOMETRY } from '../geometry.ts';

describe('React 组件', () => {
  it('SpicaMark 挂状态 class，九片瓣与几何同源', () => {
    const html = renderToStaticMarkup(<SpicaMark size={32} state="think" />);
    expect(html).toContain('class="spica-mark spica-mark--think"');
    expect(html.match(/spica-mark-petal spica-mark-petal--long/g)).toHaveLength(3);
    expect(html.match(/spica-mark-petal spica-mark-petal--short/g)).toHaveLength(6);
    for (const p of MARK_GEOMETRY.petals) expect(html).toContain(`d="${p.d}"`);
    expect(html).toContain(`transform="${MARK_GEOMETRY.groupTransform}"`);
  });

  it('idle 不挂状态 class；accentLocked 挂 accent lock', () => {
    expect(renderToStaticMarkup(<SpicaMark />)).toContain('class="spica-mark"');
    expect(renderToStaticMarkup(<SpicaMark accentLocked />)).toContain('spica-mark--accent-lock');
  });

  it('字标与横标可渲染', () => {
    expect(renderToStaticMarkup(<SpicaWordmark height={20} title="Spica" />)).toContain('aria-label="Spica"');
    const banner = renderToStaticMarkup(<SpicaBanner height={28} state="work-2" />);
    expect(banner).toContain('spica-mark--work-2');
    expect(banner).toContain('spica-banner');
  });
});
