import { describe, expect, it } from 'vitest';
import { applyPatch, DEFAULT_SETTINGS, localDay, sanitizeSettings, splashFor } from './settings';

describe('sanitizeSettings', () => {
  it('turns garbage into defaults', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ zoom: 'big', skin: 42, panels: 'x', customSkins: 'no' })).toEqual(DEFAULT_SETTINGS);
  });
  it('drops broken custom skins and a skin choice that no longer exists', () => {
    const s = sanitizeSettings({
      skin: 'custom-2',
      customSkins: [{ id: 'custom-1', name: 'ok', bg: '#FFF', accent: '#123456' }, { id: 'light', name: 'clash', bg: '#fff', accent: '#000' }, { id: 'x' }],
    });
    expect(s.customSkins).toEqual([{ id: 'custom-1', name: 'ok', bg: '#ffffff', accent: '#123456' }]);
    expect(s.skin).toBe('system');
  });
  it('snaps zoom to a step', () => {
    expect(sanitizeSettings({ zoom: 1.3 }).zoom).toBe(1.25);
    expect(sanitizeSettings({ zoom: 9 }).zoom).toBe(2);
  });
});

describe('applyPatch', () => {
  it('merges and re-validates', () => {
    const s = applyPatch(DEFAULT_SETTINGS, { panels: { left: false, right: true }, zoom: 1.5 });
    expect(s.panels.left).toBe(false);
    expect(s.zoom).toBe(1.5);
  });
});

describe('opening animation', () => {
  it('plays in full the first time each day, then only briefly', () => {
    expect(splashFor({ splash: 'daily', splashShownOn: null }, '2026-11-09')).toBe('full');
    expect(splashFor({ splash: 'daily', splashShownOn: '2026-11-09' }, '2026-11-09')).toBe('brief');
    expect(splashFor({ splash: 'daily', splashShownOn: '2026-11-08' }, '2026-11-09')).toBe('full');
    expect(splashFor({ splash: 'always', splashShownOn: '2026-11-09' }, '2026-11-09')).toBe('full');
    expect(splashFor({ splash: 'never', splashShownOn: null }, '2026-11-09')).toBe('none');
  });
  it('uses the local date and keeps only valid values', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(sanitizeSettings({ splash: 'sometimes', splashShownOn: 'yesterday' })).toMatchObject({ splash: 'daily', splashShownOn: null });
  });
});

describe('doneNews (finished sub-tasks not opened yet)', () => {
  it('is empty until something finishes; a saved list keeps its ids once each, junk dropped, the newest 500', () => {
    expect(sanitizeSettings({}).doneNews).toEqual([]);
    expect(sanitizeSettings({ doneNews: 'x' }).doneNews).toEqual([]);
    expect(sanitizeSettings({ doneNews: ['a', 'b', 'a', 3, '', null] }).doneNews).toEqual(['a', 'b']);
    const many = Array.from({ length: 600 }, (_, i) => 'n' + i);
    expect(sanitizeSettings({ doneNews: many }).doneNews).toEqual(many.slice(-500));
  });
});
