import { useCallback, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { ACCENT_LOCK_CLICKS, MARK_CENTER, MARK_GEOMETRY, MARK_VIEWBOX, SPARKLES, fmt, markGeometry, type MarkParams } from '../geometry.ts';

/**
 * 标志的状态（与 styles.css 里的 spica-mark--<state> 对应）：
 * think 等模型答复 · busy 正在回复 · tool 调用工具 · await 等工具或等人确认 ·
 * done 完成那一下 · work-1/2/3 后台负荷三档 · boot 开机画面
 */
export type MarkState = 'idle' | 'think' | 'busy' | 'tool' | 'await' | 'done' | 'work-1' | 'work-2' | 'work-3' | 'boot';

export interface SpicaMarkProps {
  /** 边长（px）；不给则随容器 */
  size?: number | string;
  state?: MarkState;
  /** 无障碍名称；不给则 aria-hidden */
  title?: string;
  className?: string;
  style?: CSSProperties;
  /** 几何参数（缺省应用内定稿） */
  params?: Readonly<MarkParams>;
  /** 允许点击（每下转 120°、轴弹一下；累计到一定次数触发 accent lock） */
  tappable?: boolean;
  /** 外部控制 accent lock（长瓣常驻 --spica-accent-lock 颜色）；不给则由点击次数决定 */
  accentLocked?: boolean;
  /** accent lock 首次触发时回调（调用方可自行持久化） */
  onAccentLock?: () => void;
}

const C = fmt(MARK_CENTER);

/** 点击反馈：每下整体转 120°（三片长瓣对称，转完看不出接缝）、轴弹一下、放一圈涟漪；每三下一圈冲击波。 */
function useTaps(onAccentLock?: () => void) {
  const [count, setCount] = useState(0);
  const lockedRef = useRef(false);
  const onTap = useCallback(() => {
    setCount((n) => {
      const next = n + 1;
      if (next >= ACCENT_LOCK_CLICKS && !lockedRef.current) {
        lockedRef.current = true;
        onAccentLock?.();
      }
      return next;
    });
  }, [onAccentLock]);
  return { count, onTap, locked: count >= ACCENT_LOCK_CLICKS };
}

export function SpicaMark({
  size,
  state = 'idle',
  title,
  className,
  style,
  params,
  tappable = false,
  accentLocked,
  onAccentLock,
}: SpicaMarkProps) {
  const geo = params ? markGeometry(params) : MARK_GEOMETRY;
  const { count, onTap, locked } = useTaps(onAccentLock);
  const lockOn = accentLocked ?? locked;
  const handleClick = tappable ? (e: MouseEvent) => { e.preventDefault(); onTap(); } : undefined;

  const cls = ['spica-mark'];
  if (state !== 'idle') cls.push(`spica-mark--${state}`);
  if (lockOn) cls.push('spica-mark--accent-lock');
  if (tappable) cls.push('spica-mark--tappable');
  if (tappable && count > 0 && count % 3 === 0) cls.push('spica-mark--shock');
  if (className) cls.push(className);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}
      width={size}
      height={size}
      className={cls.join(' ')}
      style={style}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      onClick={handleClick}
    >
      <g transform={geo.groupTransform}>
        {/* 装饰：默认透明，只由状态点亮 */}
        <circle className="spica-mark-wave" cx={C} cy={C} r="6" />
        <circle className="spica-mark-wave spica-mark-wave--2" cx={C} cy={C} r="6" />
        <circle className="spica-mark-shock" key={`shock-${count}`} cx={C} cy={C} r="6" />
        <circle className="spica-mark-halo" key={`halo-${count}`} cx={C} cy={C} r={fmt(geo.params.hubRadius)} data-on={count > 0 || undefined} />
        {SPARKLES.map(([px, py], i) => (
          <circle
            key={`spk-${i}`}
            className="spica-mark-spk"
            cx={C}
            cy={C}
            r="1.1"
            style={{ '--px': `${px}px`, '--py': `${py}px` } as CSSProperties}
          />
        ))}
        <g className="spica-mark-whole" style={{ '--turn': `${count * 120}deg` } as CSSProperties}>
          {geo.petals.map((p) => (
            <g
              key={p.index}
              className={`spica-mark-petal spica-mark-petal--${p.long ? 'long' : 'short'}`}
              style={
                {
                  '--i': p.index,
                  '--dx': `${p.flyDx}px`,
                  '--dy': `${p.flyDy}px`,
                  '--rot': `${p.flyRotate}deg`,
                  '--tw': `${p.twinkle}s`,
                } as CSSProperties
              }
            >
              <path transform={`rotate(${p.angle} ${C} ${C})`} d={p.d} />
            </g>
          ))}
          <circle className="spica-mark-hub" key={`hub-${count}`} cx={C} cy={C} r={fmt(geo.params.hubRadius)} data-hop={count > 0 || undefined} />
        </g>
      </g>
    </svg>
  );
}
