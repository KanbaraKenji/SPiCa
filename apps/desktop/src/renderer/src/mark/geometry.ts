// Geometry of the Spica mark: a nine-petal flower in a 64x64 viewBox.
// Three long petals (0/120/240 degrees) use the accent color; six short
// petals and the center axis use the ink color (currentColor).
// This module is the single source of truth for the mark's numbers.

export const MARK_VIEWBOX = 64;
export const MARK_CENTER = { x: 32, y: 32 } as const;

export interface MarkParams {
  /** Long / short petal length in local units (base at y = 27, pointing up). */
  longLength: number;
  shortLength: number;
  /** Long / short petal half-width at the first control point. */
  longWidth: number;
  shortWidth: number;
  /** Radius of the center axis circle. */
  axisRadius: number;
  /** Overall scale applied around the center. */
  scale: number;
  /** Vertical offset of the flower center after scaling (optical centering). */
  offsetY: number;
  /** Angle between neighbouring petals, in degrees. */
  petalStep: number;
}

export const DEFAULT_MARK_PARAMS: MarkParams = {
  longLength: 24,
  shortLength: 16,
  longWidth: 4.2,
  shortWidth: 3.4,
  axisRadius: 4.5,
  scale: 1.15,
  offsetY: 5,
  petalStep: 40,
};

const PETAL_BASE_Y = 27;

function fmt(n: number): string {
  // Round to 3 decimals and drop trailing zeros so paths stay readable.
  return String(Math.round(n * 1000) / 1000);
}

/** Path of one petal pointing straight up from (32, 27). */
export function petalPath(length: number, width: number): string {
  const cx = MARK_CENTER.x;
  const b = PETAL_BASE_Y;
  const c1y = b - length * 0.55;
  const c2y = b - length * 0.65;
  const tip = b - length;
  return (
    `M${fmt(cx)} ${fmt(b)}` +
    `C${fmt(cx + width)} ${fmt(c1y)} ${fmt(cx + width * 1.1)} ${fmt(c2y)} ${fmt(cx)} ${fmt(tip)}` +
    `C${fmt(cx - width * 1.1)} ${fmt(c2y)} ${fmt(cx - width)} ${fmt(c1y)} ${fmt(cx)} ${fmt(b)}Z`
  );
}

export interface Petal {
  angle: number;
  long: boolean;
  d: string;
}

export function markPetals(params: MarkParams = DEFAULT_MARK_PARAMS): Petal[] {
  const count = Math.round(360 / params.petalStep);
  const longPath = petalPath(params.longLength, params.longWidth);
  const shortPath = petalPath(params.shortLength, params.shortWidth);
  const petals: Petal[] = [];
  for (let i = 0; i < count; i++) {
    const long = i % 3 === 0;
    petals.push({ angle: i * params.petalStep, long, d: long ? longPath : shortPath });
  }
  return petals;
}

/** SVG transform that scales the flower and moves its center to (32, 32 + offsetY). */
export function markGroupTransform(params: MarkParams = DEFAULT_MARK_PARAMS): string {
  const { x, y } = MARK_CENTER;
  return `translate(${x} ${y + params.offsetY}) scale(${params.scale}) translate(${-x} ${-y})`;
}
