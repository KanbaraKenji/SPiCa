import { describe, expect, it } from 'vitest';
import { CAPTION_BACK, captionSymbol, contrast, DARK_SKIN, deriveTokens, LIGHT_SKIN, normalizeHex, ON_ACCENT_WHITE_MIN, over, resolveSkin, schemeOf } from './skin';

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
    expect(contrast(t['--spica-on-accent']!, t['--spica-accent']!)).toBeGreaterThanOrEqual(ON_ACCENT_WHITE_MIN);
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

describe('over (a see-through layer)', () => {
  it('a see-through layer over a color, as the eye gets it', () => {
    expect(over('#ffffff', 'rgba(0, 0, 0, 0.5)')).toBe('#808080');
    expect(over('#fafafa', 'rgba(15, 23, 42, 0.28)')).toBe(over('#fafafa', 'rgba(15,23,42,.28)'));
    expect(contrast(over('#fafafa', 'rgba(15, 23, 42, 0.28)'), '#fafafa')).toBeGreaterThan(1.3);
  });

  it('an opaque or unreadable layer', () => {
    expect(over('#ffffff', '#123456')).toBe('#123456');
    expect(over('#ffffff', 'oops')).toBe('#ffffff');
  });
});

describe('text on the accent (主按钮, 发送)', () => {
  const on = (accent: string, bg = '#ffffff') => deriveTokens({ id: 't', name: 't', bg, accent })['--spica-on-accent'];
  it("white on both built-in skins' blue and on every preset but the lightest", () => {
    expect(deriveTokens(LIGHT_SKIN)['--spica-on-accent']).toBe('#ffffff');
    expect(deriveTokens(DARK_SKIN)['--spica-on-accent']).toBe('#ffffff');
    for (const a of ['#2f7de1', '#62a9ff', '#7c5cff', '#e0559a', '#e8833a', '#3aa55c']) expect([a, on(a)]).toEqual([a, '#ffffff']);
  });
  it('dark only where the accent is too light for white: 39, yellow, a pale blue, white itself', () => {
    for (const a of ['#39c5bb', '#fbbf24', '#ffd400', '#a8c8ff', '#ffffff']) expect([a, on(a)]).toEqual([a, '#0b0d12']);
  });
  it('the text never falls under the least contrast, whatever the accent', () => {
    for (const a of ['#2f7de1', '#62a9ff', '#39c5bb', '#7c5cff', '#e0559a', '#e8833a', '#3aa55c', '#ffd400', '#1a2a6c', '#808080', '#ffffff', '#000000']) expect(contrast(on(a)!, a)).toBeGreaterThanOrEqual(ON_ACCENT_WHITE_MIN);
  });
  it("the least contrast sits just under white on the dark skin's blue", () => {
    const white = contrast('#ffffff', DARK_SKIN.accent);
    expect(white).toBeGreaterThanOrEqual(ON_ACCENT_WHITE_MIN);
    expect(white - ON_ACCENT_WHITE_MIN).toBeLessThan(0.1);
  });
});

describe('the caption buttons Windows draws', () => {
  it('have a see-through background (the page shows under them), whatever covers the page', () => {
    expect(CAPTION_BACK).toBe('#00000000');
  });

  it('symbols: the muted text colour; under a scrim as the scrim makes it; over the opening animation its text colour', () => {
    for (const skin of [LIGHT_SKIN, DARK_SKIN]) {
      const t = deriveTokens(skin);
      const ink = t['--spica-muted']!;
      const dark = skin === DARK_SKIN;
      expect(captionSymbol(ink, t['--spica-scrim']!, null, dark)).toBe(ink);
      expect(captionSymbol(ink, t['--spica-scrim']!, 'scrim', dark)).toBe(over(ink, t['--spica-scrim']!));
      expect(captionSymbol(ink, t['--spica-scrim']!, 'scrim', dark)).not.toBe(ink);
      expect(captionSymbol(ink, t['--spica-scrim']!, 'splash', dark)).toBe(dark ? '#f1f5f9' : '#0f172a');
    }
  });

});
