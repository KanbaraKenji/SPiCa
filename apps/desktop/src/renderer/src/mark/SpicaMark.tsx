import { MARK_CENTER, MARK_VIEWBOX, markGroupTransform, markPetals, DEFAULT_MARK_PARAMS } from './geometry';

export interface SpicaMarkProps {
  size?: number;
  title?: string;
  /** State animation class (spica-mark--think / busy / tool / await / done); placeholders until @spica/brand ships its own. */
  className?: string;
}

/**
 * The Spica mark drawn from geometry. Short petals and the axis use
 * `currentColor`; long petals use the `--spica-accent` CSS variable, so the
 * mark follows light/dark mode and future skins without new assets.
 */
export function SpicaMark({ size = 96, title, className }: SpicaMarkProps) {
  const petals = markPetals();
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}
      width={size}
      height={size}
      className={className ? `spica-mark ${className}` : 'spica-mark'}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <g transform={markGroupTransform()}>
        {petals.map((p, i) => (
          <path
            className={p.long ? 'petal petal-long' : 'petal'}
            style={{ ['--i' as string]: i }}
            key={p.angle}
            d={p.d}
            transform={`rotate(${p.angle} ${MARK_CENTER.x} ${MARK_CENTER.y})`}
            fill={p.long ? 'var(--spica-accent)' : 'currentColor'}
          />
        ))}
        <circle cx={MARK_CENTER.x} cy={MARK_CENTER.y} r={DEFAULT_MARK_PARAMS.axisRadius} fill="currentColor" />
      </g>
    </svg>
  );
}
