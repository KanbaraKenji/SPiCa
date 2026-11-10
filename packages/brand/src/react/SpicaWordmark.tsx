import type { CSSProperties } from 'react';
import { MARK_GEOMETRY, MARK_VIEWBOX, fmt } from '../geometry.ts';
import { bannerLayout, wordmarkViewBox } from '../svg.ts';
import { WORDMARK, type Wordmark } from '../wordmark.ts';
import { SpicaMark, type SpicaMarkProps } from './SpicaMark.tsx';

function WordmarkShapes({ wordmark }: { wordmark: Wordmark }) {
  return (
    <>
      {wordmark.shapes.map((s, i) =>
        s.kind === 'fill' ? (
          <path key={i} fill="currentColor" fillRule={s.evenOdd ? 'evenodd' : undefined} d={s.d} />
        ) : (
          <path
            key={i}
            fill="none"
            stroke="currentColor"
            strokeWidth={s.strokeWidth}
            strokeLinecap="square"
            strokeLinejoin="miter"
            d={s.d}
          />
        ),
      )}
    </>
  );
}

export interface SpicaWordmarkProps {
  /** 高度（px）；宽度按比例 */
  height?: number;
  title?: string;
  /** 字标（缺省仓库自带的 Spica）；换应用名时传按名字生成的字标 */
  wordmark?: Wordmark;
  className?: string;
  style?: CSSProperties;
}

/** 字标：颜色跟 currentColor */
export function SpicaWordmark({ height, title, wordmark = WORDMARK, className, style }: SpicaWordmarkProps) {
  const vb = wordmarkViewBox(wordmark);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 ${fmt(vb.y)} ${vb.width} ${vb.height}`}
      height={height}
      width={height ? (height * vb.width) / vb.height : undefined}
      className={className ? `spica-wordmark ${className}` : 'spica-wordmark'}
      style={style}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <WordmarkShapes wordmark={wordmark} />
    </svg>
  );
}

export interface SpicaBannerProps extends Pick<SpicaMarkProps, 'state' | 'tappable' | 'accentLocked' | 'onAccentLock'> {
  /** 高度（px）；宽度按比例 */
  height?: number;
  /** 无障碍名称（缺省字标的文字，再缺省 Spica） */
  title?: string;
  /** 字标（缺省仓库自带的 Spica）；换应用名时传按名字生成的字标 */
  wordmark?: Wordmark;
  className?: string;
  style?: CSSProperties;
}

/**
 * 横标：花标 + 字标，与 bannerSvg() 同一排版。
 * 花标部分是完整的 SpicaMark，状态动效与点击照常可用。
 */
export function SpicaBanner({ height, title, wordmark = WORDMARK, className, style, ...mark }: SpicaBannerProps) {
  const L = bannerLayout(wordmark);
  return (
    <span
      className={className ? `spica-banner ${className}` : 'spica-banner'}
      style={{ display: 'inline-flex', alignItems: 'center', height, aspectRatio: `${fmt(L.width)} / ${fmt(L.height)}`, ...style }}
      role="img"
      aria-label={title ?? wordmark.text ?? 'Spica'}
    >
      <svg viewBox={`0 ${fmt(L.top)} ${fmt(L.width)} ${fmt(L.height)}`} height="100%" width="100%" aria-hidden="true" style={{ overflow: 'visible' }}>
        {/* 嵌套 svg：宽高按父画框的单位算，正好占 64 见方 */}
        <SpicaMark size={MARK_VIEWBOX} {...mark} />
        <g transform={L.wordTransform}>
          <WordmarkShapes wordmark={wordmark} />
        </g>
      </svg>
    </span>
  );
}

/** 花在 64 画框里的中心（给需要对齐装饰的调用方） */
export const MARK_ORIGIN = { x: MARK_GEOMETRY.cx, y: MARK_GEOMETRY.cy } as const;
