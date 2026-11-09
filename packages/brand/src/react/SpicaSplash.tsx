import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { MARK_CENTER, MARK_GEOMETRY, MARK_VIEWBOX, fmt, sparklePath } from '../geometry.ts';
import { SPLASH_LAYOUT, SPLASH_STAGE, splashFrame, splashStaticFrame, starfield, type SplashFrame } from '../splash.ts';
import { WORDMARK } from '../wordmark.ts';

export interface SpicaSplashProps {
  /** 加载完成：从这一刻起播收尾（双星合一 → 全亮 → 逐字点亮 → 淡出） */
  ready: boolean;
  /** 收尾播完、整层淡出后回调；调用方在这里卸载组件 */
  onDone?: () => void;
  theme?: 'dark' | 'light';
  /** 横标下方的小字（例如版本号） */
  caption?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const C = fmt(MARK_CENTER);
const L = SPLASH_LAYOUT;
const STAR_R = 7;
const STAR_SPARKLE = sparklePath(0, 0, STAR_R * 2.4, 0.16);
/** 同时最多三颗：蓝星、伴星、掠字的光 */
const STAR_SLOTS = 3;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * 开机画面「暗处亮起 · 双星互绕」。铺满父元素（父元素需要定位）。
 * 时间线在 splash.ts，这里只负责按帧把状态写到 SVG 和画布上。
 */
export function SpicaSplash({ ready, onDone, theme = 'dark', caption, className, style }: SpicaSplashProps) {
  const id = useId().replace(/:/g, '');
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<SVGSVGElement>(null);
  const glowRef = useRef<SVGCircleElement>(null);
  const shockRef = useRef<SVGCircleElement>(null);
  const hubRef = useRef<SVGCircleElement>(null);
  const petalRefs = useRef<Array<SVGGElement | null>>([]);
  const letterRefs = useRef<Array<SVGGElement | null>>([]);
  const starRefs = useRef<Array<SVGGElement | null>>([]);
  const readyAtRef = useRef<number | null>(null);
  const t0Ref = useRef<number>(0);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // 记下 ready 的时刻（相对开机画面出现）
  useEffect(() => {
    if (ready && readyAtRef.current === null) {
      readyAtRef.current = t0Ref.current ? (performance.now() - t0Ref.current) / 1000 : 0;
    }
  }, [ready]);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    t0Ref.current = performance.now();
    if (ready && readyAtRef.current === null) readyAtRef.current = 0;

    const apply = (f: SplashFrame) => {
      layerRef.current?.style.setProperty('opacity', fmt(f.layer));
      canvas.style.opacity = fmt(f.layer);
      glowRef.current?.setAttribute('opacity', fmt(f.glow));
      hubRef.current?.setAttribute('r', fmt(MARK_GEOMETRY.params.hubRadius * f.hubScale));
      hubRef.current?.setAttribute('opacity', fmt(f.appear));
      const sh = shockRef.current;
      if (sh) {
        sh.setAttribute('r', fmt(f.shock?.r ?? 0));
        sh.setAttribute('opacity', fmt(f.shock?.opacity ?? 0));
        sh.setAttribute('stroke-width', fmt(f.shock?.width ?? 0));
      }
      f.petals.forEach((p, i) => {
        const g = petalRefs.current[i];
        if (!g) return;
        g.setAttribute('opacity', fmt(p.opacity));
        g.setAttribute('transform', `translate(${C} ${C}) scale(${fmt(p.scale)}) translate(-${C} -${C})`);
      });
      f.letters.forEach((l, i) => {
        const g = letterRefs.current[i];
        if (!g) return;
        g.setAttribute('opacity', fmt(l.opacity));
        g.setAttribute('transform', `translate(0 ${fmt(l.dy / L.wordScale)})`);
      });
      for (let i = 0; i < STAR_SLOTS; i++) {
        const g = starRefs.current[i];
        if (!g) continue;
        const s = f.stars[i];
        g.setAttribute('opacity', fmt(s?.opacity ?? 0));
        if (s) {
          g.setAttribute('transform', `translate(${fmt(s.x)} ${fmt(s.y)})`);
          g.setAttribute('class', s.companion ? 'spica-splash-star spica-splash-star--companion' : 'spica-splash-star');
        }
      }
    };

    // 减弱动效：静态完整画面，ready 后稍停即结束
    if (reducedMotion()) {
      apply(splashStaticFrame());
      let timer = 0;
      const check = window.setInterval(() => {
        if (readyAtRef.current !== null && !timer) {
          timer = window.setTimeout(() => onDoneRef.current?.(), 600);
        }
      }, 100);
      return () => {
        window.clearInterval(check);
        window.clearTimeout(timer);
      };
    }

    const ctx = canvas.getContext('2d');
    let colors = { star: '#DCE8FF', accent: '#62A9FF' };
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(root.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(root.clientHeight * dpr));
      const cs = getComputedStyle(root);
      colors = {
        star: cs.getPropertyValue('--spica-splash-star').trim() || colors.star,
        accent: cs.getPropertyValue('--spica-splash-accent').trim() || colors.accent,
      };
    };
    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(root);

    let raf = 0;
    let finished = false;
    const tick = (now: number) => {
      const t = (now - t0Ref.current) / 1000;
      const f = splashFrame(t, readyAtRef.current);
      apply(f);
      if (ctx) {
        const w = canvas.width;
        const h = canvas.height;
        const scale = Math.min(w / SPLASH_STAGE.width, h / SPLASH_STAGE.height);
        ctx.clearRect(0, 0, w, h);
        ctx.lineCap = 'round';
        for (const s of starfield(t, readyAtRef.current, w, h, scale)) {
          if (s.opacity <= 0.005) continue;
          ctx.globalAlpha = s.opacity;
          ctx.strokeStyle = s.accent ? colors.accent : colors.star;
          ctx.lineWidth = s.width;
          ctx.beginPath();
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(s.x2, s.y2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      if (f.finished && !finished) {
        finished = true;
        onDoneRef.current?.();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
    // 换主题时重启循环（重新读颜色）；ready 通过 ref 传进循环，不触发重启
  }, [theme]);

  const markTransform = `translate(${fmt(L.cx)} ${fmt(L.cy)}) scale(${fmt(L.markScale)}) translate(-${C} -${C})`;
  const wordTransform = `translate(${fmt(L.wordX)} ${fmt(L.wordY)}) scale(${fmt(L.wordScale)})`;

  return (
    <div
      ref={rootRef}
      className={className ? `spica-splash ${className}` : 'spica-splash'}
      data-theme={theme}
      style={style}
      role="img"
      aria-label="Spica"
    >
      <canvas ref={canvasRef} className="spica-splash-stars" aria-hidden="true" />
      <svg
        ref={layerRef}
        className="spica-splash-stage"
        viewBox={`0 0 ${SPLASH_STAGE.width} ${SPLASH_STAGE.height}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <defs>
          <radialGradient id={`${id}-glow`}>
            <stop offset="0" className="spica-splash-glow-core" />
            <stop offset="0.45" className="spica-splash-glow-mid" />
            <stop offset="1" className="spica-splash-glow-edge" />
          </radialGradient>
          <radialGradient id={`${id}-star`}>
            <stop offset="0" className="spica-splash-glow-mid" />
            <stop offset="1" className="spica-splash-glow-edge" />
          </radialGradient>
        </defs>
        <circle ref={glowRef} cx={fmt(L.cx)} cy={fmt(L.cy)} r={fmt((SPLASH_STAGE.height * 0.36 * 70) / MARK_VIEWBOX)} fill={`url(#${id}-glow)`} opacity="0" />
        <g transform={markTransform}>
          {MARK_GEOMETRY.petals.map((p, i) => (
            <g
              key={p.index}
              ref={(el) => {
                petalRefs.current[i] = el;
              }}
              className={`spica-splash-petal spica-splash-petal--${p.long ? 'long' : 'short'}`}
              opacity="0"
            >
              <path transform={`rotate(${p.angle} ${C} ${C})`} d={p.d} />
            </g>
          ))}
          <circle ref={hubRef} className="spica-splash-hub" cx={C} cy={C} r={fmt(MARK_GEOMETRY.params.hubRadius)} opacity="0" />
        </g>
        <circle ref={shockRef} className="spica-splash-shock" cx={fmt(L.cx)} cy={fmt(L.cy)} r="0" opacity="0" />
        <g transform={wordTransform}>
          {WORDMARK.shapes.map((s, i) => (
            <g
              key={i}
              ref={(el) => {
                letterRefs.current[i] = el;
              }}
              opacity="0"
            >
              {s.kind === 'fill' ? (
                <path className="spica-splash-letter" fillRule={s.evenOdd ? 'evenodd' : undefined} d={s.d} />
              ) : (
                <path
                  className="spica-splash-letter spica-splash-letter--stroke"
                  strokeWidth={s.strokeWidth}
                  strokeLinecap="square"
                  strokeLinejoin="miter"
                  d={s.d}
                />
              )}
            </g>
          ))}
        </g>
        {Array.from({ length: STAR_SLOTS }, (_, i) => (
          <g
            key={i}
            ref={(el) => {
              starRefs.current[i] = el;
            }}
            className="spica-splash-star"
            opacity="0"
          >
            <circle r={STAR_R * 2.6} fill={`url(#${id}-star)`} opacity="0.5" />
            <path className="spica-splash-star-shape" d={STAR_SPARKLE} />
            <circle className="spica-splash-star-core" r={STAR_R * 0.55} />
          </g>
        ))}
      </svg>
      {caption ? <div className="spica-splash-caption">{caption}</div> : null}
    </div>
  );
}
