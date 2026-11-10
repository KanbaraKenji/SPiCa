import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SpicaStatusIcon } from './react/SpicaStatusIcon.tsx';
import { STATUS_ICON_NAMES, STATUS_ICON_TONE, statusIconBody, statusIconSvg } from './status-icons.ts';

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
  it('九种状态都在，同一套：24 网格、线宽 2.5、圆圈半径 9.5', () => {
    expect([...STATUS_ICON_NAMES]).toEqual(['done', 'running', 'warning', 'error', 'waiting', 'question', 'stopped', 'queued', 'info']);
    for (const n of STATUS_ICON_NAMES) {
      const svg = statusIconSvg(n);
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).toContain('stroke-width="2.5"');
      expect(svg).toContain('<circle cx="12" cy="12" r="9.5"');
      // 只有一种线宽（done 的遮罩里那条 5 宽的切口线不算图形）
      if (n !== 'done') expect(svg.match(/stroke-width="[^"]+"/g)).toEqual(['stroke-width="2.5"']);
    }
  });

  it('每种状态默认取皮肤的语义色，样式里都写了', () => {
    const css = readFileSync(path.join(here, 'styles/status.css'), 'utf8');
    expect(STATUS_ICON_TONE).toEqual({
      done: '--spica-success',
      running: '--spica-accent',
      warning: '--spica-warning',
      error: '--spica-danger',
      waiting: '--spica-warning',
      question: '--spica-warning',
      stopped: '--spica-muted',
      queued: '--spica-muted',
      info: '--spica-accent',
    });
    for (const n of STATUS_ICON_NAMES) {
      // 这个状态所在的那条规则（可能和别的状态共用一条），颜色是它的语义色
      const at = css.indexOf(`[data-status='${n}']`);
      expect(at).toBeGreaterThan(-1);
      const block = css.slice(css.indexOf('{', at), css.indexOf('}', at));
      expect(block).toContain(`color: var(${STATUS_ICON_TONE[n]},`);
    }
  });

  it('进行中的亮弧会转，减弱动效时不转', () => {
    expect(statusIconBody('running')).toContain('class="spica-status-spin"');
    const css = readFileSync(path.join(here, 'styles/status.css'), 'utf8');
    expect(css).toMatch(/\.spica-status-spin \{[^}]*animation: spica-status-spin/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[^}]*\.spica-status-spin \{\s*animation: none/);
  });

  it('给了颜色时图形里的 currentColor 跟着它（已停止的实心方块也是）', () => {
    const svg = statusIconSvg('stopped', { color: '#f87171', size: 16 });
    expect(svg).toContain('color="#f87171"');
    expect(svg).toContain('fill="currentColor"');
    expect(svg).toContain('width="16"');
  });

  it('品牌素材里的单个 SVG 和代码一致（brand:build 生成，完成那个是原件）', () => {
    for (const n of STATUS_ICON_NAMES) {
      if (n === 'done') continue;
      expect(source(`spica-${n}.svg`)).toBe(`${statusIconSvg(n)}
`);
    }
  });

  it('React 版：每种状态都能画，data-status 对应名字', () => {
    for (const n of STATUS_ICON_NAMES) {
      const html = renderToStaticMarkup(<SpicaStatusIcon name={n} />);
      expect(html).toContain(`data-status="${n}"`);
      expect(html).toContain('class="spica-status-icon"');
    }
  });
});
