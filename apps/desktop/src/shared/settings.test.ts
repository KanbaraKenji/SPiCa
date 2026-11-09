import { describe, expect, it } from 'vitest';
import { applyPatch, DEFAULT_SETTINGS, sanitizeSettings } from './settings';

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
