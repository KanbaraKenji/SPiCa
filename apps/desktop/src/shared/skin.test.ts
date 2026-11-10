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
  // The reference's values, measured (统筹 2026-11-10); each must come out exactly.
  const measured = {
    dark: { bg: '#191919', chrome: '#1f1f1f', ink: '#efefef', bubble: '#252525', input: '#303030', menu: '#303030', 'menu-hover': '#454545', active: '#404040', hover: '#2a2a2a', muted: '#9c9c9c', placeholder: '#878787', border: '#222222', 'border-strong': '#474747', code: '#2a2a2a', control: '#3b3b3b' },
    light: { bg: '#ffffff', chrome: '#fafafa', ink: '#191919', bubble: '#f3f3f3', input: '#ffffff', menu: '#ffffff', 'menu-hover': '#e5e5e5', active: '#e1e1e1', hover: '#eeeeee', muted: '#666666', placeholder: '#878787', 'border-strong': '#cecece', code: '#f2f2f2', control: '#f2f2f2', divider: '#e1e1e1' },
  };
  it.each([
    ['dark', DARK_SKIN],
    ['light', LIGHT_SKIN],
  ] as const)('built-in %s: the measured reference values, all neutral greys', (name, skin) => {
    const t = deriveTokens(skin);
    for (const [k, v] of Object.entries(measured[name])) expect([k, t[`--spica-${k}`]]).toEqual([k, v]);
    for (const k of ['--spica-chrome', '--spica-bubble', '--spica-input', '--spica-raised', '--spica-surface', '--spica-border', '--spica-muted', '--spica-faint'] as const) {
      const v = t[k]!;
      expect([k, v.slice(1, 3) === v.slice(3, 5) && v.slice(3, 5) === v.slice(5, 7)]).toEqual([k, true]);
    }
  });
  it('a skin someone made is derived as before: panels darker than the conversation, the default text, menus and inputs as the general layers', () => {
    const t = deriveTokens({ id: 'c4', name: 'w', bg: '#191919', accent: '#62a9ff' });
    expect(t['--spica-chrome']).toBe('#141414');
    expect(t['--spica-ink']).toBe('#ecebe5');
    expect(t['--spica-menu']).toBe(t['--spica-raised']);
    expect(t['--spica-menu-hover']).toBe(t['--spica-hover']);
    expect(t['--spica-input-border']).toBe(t['--spica-border-strong']);
    expect(t['--spica-divider']).toBe(t['--spica-border']);
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
