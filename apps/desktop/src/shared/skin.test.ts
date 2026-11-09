import { describe, expect, it } from 'vitest';
import { contrast, DARK_SKIN, deriveTokens, LIGHT_SKIN, normalizeHex, resolveSkin, schemeOf } from './skin';

describe('normalizeHex', () => {
  it('accepts short and long forms, with or without #', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('39c5bb')).toBe('#39c5bb');
    expect(normalizeHex(' #39C5BB ')).toBe('#39c5bb');
  });
  it('rejects anything else', () => {
    expect(normalizeHex('red')).toBeUndefined();
    expect(normalizeHex('#12345')).toBeUndefined();
  });
});

describe('deriveTokens', () => {
  const skins = [
    LIGHT_SKIN,
    DARK_SKIN,
    { id: 'c1', name: 'x', bg: '#fff8e7', accent: '#ffd400' }, // light bg, pale accent
    { id: 'c2', name: 'y', bg: '#0b1d2a', accent: '#1a2a6c' }, // dark bg, dark accent
    { id: 'c3', name: 'z', bg: '#808080', accent: '#39c5bb' }, // mid grey
  ];
  it.each(skins)('keeps text readable on $bg', (skin) => {
    const t = deriveTokens(skin);
    expect(contrast(t['--spica-ink']!, t['--spica-bg']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--spica-faint']!, t['--spica-bg']!)).toBeGreaterThanOrEqual(2.5);
    expect(contrast(t['--spica-muted']!, t['--spica-bg']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--spica-accent-text']!, t['--spica-bg']!)).toBeGreaterThanOrEqual(3);
    expect(contrast(t['--spica-on-accent']!, t['--spica-accent']!)).toBeGreaterThanOrEqual(3);
  });
  it('derives the scheme from the background', () => {
    expect(schemeOf(LIGHT_SKIN.bg)).toBe('light');
    expect(schemeOf(DARK_SKIN.bg)).toBe('dark');
  });
});

describe('resolveSkin', () => {
  const custom = [{ id: 'custom-1', name: '我的', bg: '#101010', accent: '#ff0000' }];
  it('follows the system for "system"', () => {
    expect(resolveSkin('system', true, custom)).toBe(DARK_SKIN);
    expect(resolveSkin('system', false, custom)).toBe(LIGHT_SKIN);
  });
  it('finds custom skins and falls back when one was deleted', () => {
    expect(resolveSkin('custom-1', false, custom).bg).toBe('#101010');
    expect(resolveSkin('custom-9', false, custom)).toBe(LIGHT_SKIN);
  });
});
