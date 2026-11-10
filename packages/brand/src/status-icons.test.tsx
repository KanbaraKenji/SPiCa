import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SpicaStatusIcon } from './react/SpicaStatusIcon.tsx';
import { statusIconBody, statusIconSvg } from './status-icons.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(path.join(here, '../../../branding/icons', file), 'utf8');
/** 去掉标签之间的空白，只比图形 */
const inner = (svg: string) => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/>\s+</g, '><').trim();

describe('带圈状态图标', () => {
  it('完成：和素材原件 branding/icons/spica-check.svg 逐字一致', () => {
    const file = source('spica-check.svg');
    expect(statusIconBody('done')).toBe(inner(file));
    // 外层属性也一样：24 网格、线宽 2.5、圆头、颜色随调用处
    for (const attr of ['viewBox="0 0 24 24"', 'fill="none"', 'stroke="currentColor"', 'stroke-width="2.5"', 'stroke-linecap="round"', 'stroke-linejoin="round"']) {
      expect(file).toContain(attr);
      expect(statusIconSvg('done')).toContain(attr);
    }
  });

  it('预览版只是把颜色填成绿色，图形相同', () => {
    expect(inner(source('spica-check-preview.svg'))).toBe(inner(source('spica-check.svg')));
  });

  it('React 版：同一页多个实例的遮罩 id 不重复，颜色挂在 data-status 上', () => {
    const html = renderToStaticMarkup(
      <>
        <SpicaStatusIcon name="done" />
        <SpicaStatusIcon name="done" size={15} title="已完成" />
      </>,
    );
    const ids = [...html.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(html).toContain(`mask="url(#${id})"`);
    expect(html).toContain('data-status="done"');
    expect(html).toContain('stroke-width="2.5"');
    expect(html).toContain('aria-label="已完成"');
    expect(html).toContain('width="15"');
  });
});
