import { describe, expect, it } from 'vitest';
import { CONTEXT_FALLBACK, contextColours, parseColor } from './context-palette';

const skin = { warning: '#d97706', danger: '#dc2626', bg: '#191919' };

describe('context card colours', () => {
  it('reads #rgb, #rrggbb and rgb()', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255]);
    expect(parseColor(' #3b82f6 ')).toEqual([59, 130, 246]);
    expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3]);
    expect(parseColor('var(--x)')).toBeNull();
  });

  it('follow the accent: darker, as is, lighter; darker steps on a dark skin', () => {
    const c = contextColours({ ...skin, accent: '#8b5cf6' });
    expect(c).toEqual({ system: 'color-mix(in oklab, #8b5cf6 68%, #000)', tools: '#8b5cf6', messages: 'color-mix(in oklab, #8b5cf6 45%, #fff)', fallback: false });
    expect(contextColours({ ...skin, accent: '#8b5cf6', bg: '#ffffff' }).system).toBe('color-mix(in oklab, #8b5cf6 55%, #000)');
  });

  it('an accent near the warning or error hue, or a grey one, gives way to blue', () => {
    expect(contextColours({ ...skin, accent: '#e11d48' })).toMatchObject({ tools: CONTEXT_FALLBACK.dark, fallback: true });
    expect(contextColours({ ...skin, accent: '#f59e0b', bg: '#fff' })).toMatchObject({ tools: CONTEXT_FALLBACK.light, fallback: true });
    expect(contextColours({ ...skin, accent: '#777777' }).fallback).toBe(true);
    expect(contextColours({ ...skin, accent: '' }).fallback).toBe(true);
    // Green is far from both.
    expect(contextColours({ ...skin, accent: '#16a37f' }).fallback).toBe(false);
  });
});
