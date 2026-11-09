import { describe, expect, it } from 'vitest';
import { markGroupTransform, markPetals, petalPath } from './geometry';

describe('Spica mark geometry', () => {
  it('reproduces the reference long and short petal paths', () => {
    expect(petalPath(24, 4.2)).toBe('M32 27C36.2 13.8 36.62 11.4 32 3C27.38 11.4 27.8 13.8 32 27Z');
    expect(petalPath(16, 3.4)).toBe('M32 27C35.4 18.2 35.74 16.6 32 11C28.26 16.6 28.6 18.2 32 27Z');
  });

  it('has nine petals, long ones at 0/120/240 degrees', () => {
    const petals = markPetals();
    expect(petals).toHaveLength(9);
    expect(petals.filter((p) => p.long).map((p) => p.angle)).toEqual([0, 120, 240]);
  });

  it('centers the scaled flower at (32, 37)', () => {
    expect(markGroupTransform()).toBe('translate(32 37) scale(1.15) translate(-32 -32)');
  });
});
