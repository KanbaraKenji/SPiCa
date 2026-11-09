import { describe, expect, it } from 'vitest';
import { clampZoom, stepZoom, ZOOM_STEPS, zoomLabel } from './zoom';

describe('zoom', () => {
  it('steps through the ladder and stops at the ends', () => {
    expect(stepZoom(1, 'in')).toBe(1.1);
    expect(stepZoom(1, 'out')).toBe(0.9);
    expect(stepZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1]!, 'in')).toBe(2);
    expect(stepZoom(ZOOM_STEPS[0]!, 'out')).toBe(0.67);
  });
  it('resets nonsense to 100%', () => {
    expect(clampZoom(Number.NaN)).toBe(1);
  });
  it('labels as percent', () => {
    expect(zoomLabel(1.25)).toBe('125%');
  });
});
