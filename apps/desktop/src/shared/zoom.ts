// Whole-window zoom steps (same ladder as Chromium, trimmed to sizes that stay usable).
export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const DEFAULT_ZOOM = 1;

/** Snaps any number to the nearest step; non-finite values reset to 100%. */
export function clampZoom(factor: number): number {
  if (!Number.isFinite(factor)) return DEFAULT_ZOOM;
  let best: number = DEFAULT_ZOOM;
  for (const step of ZOOM_STEPS) if (Math.abs(step - factor) < Math.abs(best - factor)) best = step;
  return best;
}

/** Next step in a direction; stays put at either end. */
export function stepZoom(current: number, direction: 'in' | 'out'): number {
  const i = ZOOM_STEPS.indexOf(clampZoom(current) as (typeof ZOOM_STEPS)[number]);
  const next = direction === 'in' ? Math.min(i + 1, ZOOM_STEPS.length - 1) : Math.max(i - 1, 0);
  return ZOOM_STEPS[next] ?? DEFAULT_ZOOM;
}

export function zoomLabel(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}
