import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { MARK_CENTER, MARK_GEOMETRY, fmt, sparklePath } from '../geometry.ts';
import {
  SPLASH_LAYOUT,
  SPLASH_STAGE,
  SPLASH_TIMING,
  SPLASH_TRAIL_DOTS,
  splashBriefFrame,
  splashFrame,
  splashStaticFrame,
  starfield,
  type SplashFinish,
  type SplashFrame,
} from '../splash.ts';
import { WORDMARK } from '../wordmark.ts';

export interface SpicaSplashProps {
  /** 加载完成：从这一刻起播收尾 */
  ready: boolean;
  /** 收尾播完、整层淡出后回调；调用方在这里卸载组件 */
  onDone?: () => void;
  theme?: 'dark' | 'light';
  /** full = 完整版（每天第一次打开）；brief = 短版：横标淡入、停住、淡出，约 1 秒，不放星点 */
  mode?: 'full' | 'brief';
  /** 双星转一圈的秒数（缺省 3.5 秒） */
  orbitPeriod?: number;
  /** 双星快慢比：离花心最近时的速度 ÷ 最远时（缺省 2；1 = 匀速） */
  speedRatio?: number;
  /** 收尾各步时长（缺省 SPLASH_FINISH） */
  finish?: Partial<SplashFinish>;
  /** 横标下方的小字（例如版本号） */
  caption?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const C = fmt(MARK_CENTER);
const L = SPLASH_LAYOUT;
const STAR_R = 7;
const STAR_SPARKLE = sparklePath(0, 0, STAR_R * 2.4, 0.16);
/** 同时最多三颗：蓝星、伴星、扫字的光。每颗在花标后面、前面各有一个位置，按纵深切换 */
const STAR_SLOTS = 3;
/** 拖尾光点：两颗星 × 每颗 SPLASH_TRAIL_DOTS 个，后面、前面各一组 */
const TRAIL_SLOTS = 2 * SPLASH_TRAIL_DOTS;

type Refs<T> = { current: Array<T | null> };

/** 一组星的位置（后面一组画在花标下面，前面一组画在最上面） */
function starSlots(refs: Refs<SVGGElement>, id: string) {
  return Array.from({ length: STAR_SLOTS }, (_, i) => (
    <g
      key={i}
      ref={(el) => {
        refs.current[i] = el;
      }}
      className="spica-splash-star"
      opacity="0"
    >
      <circle className="spica-splash-star-halo" r={STAR_R * 2.6} fill={`url(#${id}-star)`} opacity="0.5" />
      <path className="spica-splash-star-shape" d={STAR_SPARKLE} />
      <circle className="spica-splash-star-core" r={STAR_R * 0.55} />
    </g>
  ));
}

function trailSlots(refs: Refs<SVGCircleElement>) {
  return Array.from({ length: TRAIL_SLOTS }, (_, i) => (
    <circle
      key={i}
      ref={(el) => {
        refs.current[i] = el;
      }}
      className="spica-splash-trail"
      r="0"
      opacity="0"
    />
  ));
}

function petalPaths() {
  return (
    <>
      {MARK_GEOMETRY.petals.map((p) => (
        <path key={p.index} className={`spica-splash-petal--${p.long ? 'long' : 'short'}`} transform={`rotate(${p.angle} ${C} ${C})`} d={p.d} />
      ))}
    </>
  );
}

function letterShape(s: (typeof WORDMARK.shapes)[number], className: string) {
  return s.kind === 'fill' ? (
    <path className={className} fillRule={s.evenOdd ? 'evenodd' : undefined} d={s.d} />
  ) : (
    <path className={`${className} spica-splash-letter--stroke`} strokeWidth={s.strokeWidth} strokeLinecap="square" strokeLinejoin="miter" d={s.d} />
  );
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * 开机画面「暗处亮起 · 双星环绕」。铺满父元素（父元素需要定位）。
 * 时间线在 splash.ts，这里只负责按帧把状态写到 SVG 和画布上。
 */
export function SpicaSplash({
  ready,
  onDone,
  theme = 'dark',
  mode = 'full',
  orbitPeriod = SPLASH_TIMING.orbitPeriod,
  speedRatio,
  finish,
  caption,
  className,
  style,
}: SpicaSplashProps) {
  const id = useId().replace(/:/g, '');
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<SVGSVGElement>(null);
  const glowRef = useRef<SVGCircleElement>(null);
  const hubRef = useRef<SVGCircleElement>(null);
  const maskRef = useRef<SVGGElement>(null);
  const dimRef = useRef<SVGGElement>(null);
  const fillRef = useRef<SVGGElement>(null);
  const fillClipRef = useRef<SVGCircleElement>(null);
  const rippleRefs = useRef<Array<SVGCircleElement | null>>([]);
  const letterRefs = useRef<Array<SVGGElement | null>>([]);
  const letterGlowRefs = useRef<Array<SVGGElement | null>>([]);
  const backStarRefs = useRef<Array<SVGGElement | null>>([]);
  const frontStarRefs = useRef<Array<SVGGElement | null>>([]);
  const backTrailRefs = useRef<Array<SVGCircleElement | null>>([]);
  const frontTrailRefs = useRef<Array<SVGCircleElement | null>>([]);
  const readyAtRef = useRef<number | null>(null);
  const t0Ref = useRef<number>(0);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);
  const finishRef = useRef(finish);
  useEffect(() => {
    finishRef.current = finish;
  }, [finish]);

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
      hubRef.current?.setAttribute('opacity', fmt(f.hubOpacity));
      maskRef.current?.setAttribute('opacity', fmt(f.appear));
      dimRef.current?.setAttribute('opacity', fmt(f.petals[0]?.opacity ?? 0));
      // 水波填充：实色花标层的圆形遮罩
      fillRef.current?.setAttribute('opacity', f.fill ? '1' : '0');
      fillClipRef.current?.setAttribute('r', fmt(f.fill?.radius ?? 0));
      rippleRefs.current.forEach((c, i) => {
        const rp = f.fill?.ripples[i];
        c?.setAttribute('r', fmt(rp?.r ?? 0));
        c?.setAttribute('opacity', fmt(rp?.opacity ?? 0));
      });
      f.letters.forEach((l, i) => {
        const tr = `translate(0 ${fmt(l.dy / L.wordScale)})`;
        const g = letterRefs.current[i];
        g?.setAttribute('opacity', fmt(l.opacity));
        g?.setAttribute('transform', tr);
        const gl = letterGlowRefs.current[i];
        gl?.setAttribute('opacity', fmt(l.glow));
        gl?.setAttribute('transform', tr);
      });
      for (let i = 0; i < STAR_SLOTS; i++) {
        const s = f.stars[i];
        for (const [refs, isFront] of [[backStarRefs, false], [frontStarRefs, true]] as const) {
          const g = refs.current[i];
          if (!g) continue;
          const on = s !== undefined && s.front === isFront;
          g.setAttribute('opacity', fmt(on ? s.opacity : 0));
          if (on) {
            g.setAttribute('transform', `translate(${fmt(s.x)} ${fmt(s.y)}) scale(${fmt(s.scale)})`);
            g.setAttribute('class', s.companion ? 'spica-splash-star spica-splash-star--companion' : 'spica-splash-star');
          }
        }
      }
      for (let i = 0; i < TRAIL_SLOTS; i++) {
        const d = f.trails[i];
        for (const [refs, isFront] of [[backTrailRefs, false], [frontTrailRefs, true]] as const) {
          const c = refs.current[i];
          if (!c) continue;
          const on = d !== undefined && d.front === isFront;
          c.setAttribute('opacity', fmt(on ? d.opacity : 0));
          if (on) {
            c.setAttribute('cx', fmt(d.x));
            c.setAttribute('cy', fmt(d.y));
            c.setAttribute('r', fmt(d.r));
            c.setAttribute('class', d.companion ? 'spica-splash-trail spica-splash-trail--companion' : 'spica-splash-trail');
          }
        }
      }
    };

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

    // 减弱动效或短版：都不放星点，按短版的淡入 / 停住 / 淡出走；减弱动效时连淡入淡出都不做
    if (reducedMotion() || mode === 'brief') {
      const still = reducedMotion();
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      let raf = 0;
      const tick = (now: number) => {
        const t = (now - t0Ref.current) / 1000;
        const f = splashBriefFrame(t, readyAtRef.current);
        apply(still ? { ...splashStaticFrame(), finished: f.finished } : f);
        if (f.finished) {
          onDoneRef.current?.();
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }

    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(root);

    let raf = 0;
    let finished = false;
    const tick = (now: number) => {
      const t = (now - t0Ref.current) / 1000;
      const opts = { orbitPeriod, speedRatio, finish: finishRef.current };
      const f = splashFrame(t, readyAtRef.current, opts);
      apply(f);
      if (ctx) {
        const w = canvas.width;
        const h = canvas.height;
        const scale = Math.min(w / SPLASH_STAGE.width, h / SPLASH_STAGE.height);
        // 舞台按 meet 等比居中：花心在画布上的位置就是星点飞出的原点
        const origin = { x: (w - SPLASH_STAGE.width * scale) / 2 + L.cx * scale, y: (h - SPLASH_STAGE.height * scale) / 2 + L.cy * scale };
        ctx.clearRect(0, 0, w, h);
        ctx.lineCap = 'round';
        for (const s of starfield(t, readyAtRef.current, w, h, scale, opts, origin)) {
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
    // 换主题、模式或节奏时重启；ready 通过 ref 传进循环，不触发重启
  }, [theme, mode, orbitPeriod, speedRatio]);

  const markTransform = `translate(${fmt(L.cx)} ${fmt(L.cy)}) scale(${fmt(L.markScale)}) translate(-${C} -${C})`;
  const wordTransform = `translate(${fmt(L.wordX)} ${fmt(L.wordY)}) scale(${fmt(L.wordScale)})`;

  return (
    <div
      ref={rootRef}
      className={className ? `spica-splash ${className}` : 'spica-splash'}
      data-theme={theme}
      data-mode={mode}
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
          <clipPath id={`${id}-fill`}>
            <circle ref={fillClipRef} cx={C} cy={C} r="0" />
          </clipPath>
          <filter id={`${id}-blur`} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>
        <circle ref={glowRef} className="spica-splash-glow" cx={fmt(L.cx)} cy={fmt(L.cy)} r={fmt(L.markScale * 61)} fill={`url(#${id}-glow)`} opacity="0" />
        {trailSlots(backTrailRefs)}
        {starSlots(backStarRefs, id)}
        <g transform={markTransform}>
          {/* 底色剪影：花瓣暗着时也挡住后面的星（同一组路径，只当遮挡，不改轮廓） */}
          <g ref={maskRef} className="spica-splash-mask" opacity="0">
            {petalPaths()}
            <circle cx={C} cy={C} r={fmt(MARK_GEOMETRY.params.hubRadius)} />
          </g>
          {/* 呼吸中的暗花标 */}
          <g ref={dimRef} className="spica-splash-petals" opacity="0">
            {petalPaths()}
          </g>
          {/* 水波填充：实色花标，圆形遮罩从花心扩开 */}
          <g ref={fillRef} className="spica-splash-petals" clipPath={`url(#${id}-fill)`} opacity="0">
            {petalPaths()}
          </g>
          {[0, 1].map((i) => (
            <circle
              key={i}
              ref={(el) => {
                rippleRefs.current[i] = el;
              }}
              className="spica-splash-ripple"
              cx={C}
              cy={C}
              r="0"
              opacity="0"
            />
          ))}
          <circle ref={hubRef} className="spica-splash-hub" cx={C} cy={C} r={fmt(MARK_GEOMETRY.params.hubRadius)} opacity="0" />
        </g>
        <g transform={wordTransform}>
          {WORDMARK.shapes.map((s, i) => {
            // 辉光：暗色是一层模糊的强调色垫在字下面；浅色是一层清晰的强调色盖在字上面（不糊成脏底）
            const glow = (
              <g
                key="glow"
                ref={(el) => {
                  letterGlowRefs.current[i] = el;
                }}
                className="spica-splash-letter-glow"
                filter={theme === 'dark' ? `url(#${id}-blur)` : undefined}
                opacity="0"
              >
                {letterShape(s, 'spica-splash-letter-glow-shape')}
              </g>
            );
            const letter = (
              <g
                key="letter"
                ref={(el) => {
                  letterRefs.current[i] = el;
                }}
                opacity="0"
              >
                {letterShape(s, 'spica-splash-letter')}
              </g>
            );
            return <g key={i}>{theme === 'dark' ? [glow, letter] : [letter, glow]}</g>;
          })}
        </g>
        {trailSlots(frontTrailRefs)}
        {starSlots(frontStarRefs, id)}
      </svg>
      {caption ? <div className="spica-splash-caption">{caption}</div> : null}
    </div>
  );
}
