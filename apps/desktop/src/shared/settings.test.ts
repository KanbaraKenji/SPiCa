import { describe, expect, it } from 'vitest';
import { accountValue, applyPatch, callNameValue, DEFAULT_SETTINGS, defaultCallName, effectiveAccount, effectiveCallName, localDay, sanitizeSettings, splashFor } from './settings';

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
  it('a settings file from before the preview had its own panel: the preview gets the usual width, the old right width stays as it was', () => {
    const s = sanitizeSettings({ panels: { left: true, right: false }, panelWidths: { left: 300, right: 560 } });
    expect(s.panels).toEqual({ left: true, right: false });
    expect(s.panelWidths).toEqual({ left: 300, right: 560, preview: 640 });
    expect(sanitizeSettings({ panelWidths: { left: 300, right: 560, preview: 99999 } }).panelWidths.preview).toBe(4000);
    expect(sanitizeSettings({ panelWidths: { preview: 10 } }).panelWidths.preview).toBe(320);
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

describe('单次运行花费上限', () => {
  it('no limit by default; a positive amount is kept to the cent; anything else is no limit', () => {
    expect(DEFAULT_SETTINGS.runLimitUsd).toBeNull();
    expect(sanitizeSettings({}).runLimitUsd).toBeNull();
    expect(sanitizeSettings({ runLimitUsd: 1.5 }).runLimitUsd).toBe(1.5);
    expect(sanitizeSettings({ runLimitUsd: 0.123 }).runLimitUsd).toBe(0.12);
    expect(sanitizeSettings({ runLimitUsd: 0.001 }).runLimitUsd).toBe(0.01);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2', null, 10_001]) expect(sanitizeSettings({ runLimitUsd: bad }).runLimitUsd).toBeNull();
    expect(applyPatch(DEFAULT_SETTINGS, { runLimitUsd: 3 }).runLimitUsd).toBe(3);
    expect(applyPatch({ ...DEFAULT_SETTINGS, runLimitUsd: 3 }, { runLimitUsd: null }).runLimitUsd).toBeNull();
  });
});

describe('background and sign-in switches', () => {
  it('关闭窗口时 asks by default; 开机时启动 is off until turned on; only a real true counts', () => {
    expect(sanitizeSettings({})).toMatchObject({ closeWindow: 'ask', openAtLogin: false, backgroundHintShown: false });
    expect(sanitizeSettings({ closeWindow: 'hide', openAtLogin: 1, backgroundHintShown: null })).toMatchObject({ closeWindow: 'ask', openAtLogin: false, backgroundHintShown: false });
    expect(sanitizeSettings({ closeWindow: 'quit', openAtLogin: true, backgroundHintShown: true })).toMatchObject({ closeWindow: 'quit', openAtLogin: true, backgroundHintShown: true });
    expect(applyPatch(DEFAULT_SETTINGS, { closeWindow: 'tray' }).openAtLogin).toBe(false);
  });

  it('the earlier switch 关闭窗口后留在后台: on means minimize to the tray, off means ask; it is not kept', () => {
    expect(sanitizeSettings({ keepInBackground: true }).closeWindow).toBe('tray');
    expect(sanitizeSettings({ keepInBackground: false }).closeWindow).toBe('ask');
    expect(sanitizeSettings({ keepInBackground: true, closeWindow: 'quit' }).closeWindow).toBe('quit');
    expect('keepInBackground' in sanitizeSettings({ keepInBackground: true })).toBe(false);
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

describe('账号', () => {
  it('none typed by default; what is typed is trimmed, in capitals, without control characters', () => {
    expect(DEFAULT_SETTINGS.account).toBe('');
    expect(sanitizeSettings({ account: '  alex.chen ' }).account).toBe('ALEX.CHEN');
    expect(sanitizeSettings({ account: 'a\u0000b\nc' }).account).toBe('ABC');
    expect(sanitizeSettings({ account: 42 }).account).toBe('');
    expect(accountValue('x'.repeat(100))).toHaveLength(64);
    expect(accountValue('陈 alex')).toBe('陈 ALEX');
  });
  it('plugins get the typed one, else the automatic one', () => {
    expect(effectiveAccount({ account: '' }, 'ALEX.CHEN')).toBe('ALEX.CHEN');
    expect(effectiveAccount({ account: 'CHEN.A' }, 'ALEX.CHEN')).toBe('CHEN.A');
    expect(effectiveAccount({ account: '' }, '')).toBe('');
  });
});

describe('账号 › 昵称', () => {
  it('from the account: the part before the first dot or space, first letter in capitals', () => {
    expect(defaultCallName('ALEX.CHEN')).toBe('Alex');
    expect(defaultCallName('ALEX CHEN')).toBe('Alex');
    expect(defaultCallName('CHEN')).toBe('Chen');
    expect(defaultCallName('陈明')).toBe('陈明');
    expect(defaultCallName('')).toBe('');
    expect(defaultCallName('.X')).toBe('');
  });
  it('the one typed wins; kept as typed (case too), trimmed', () => {
    expect(sanitizeSettings({ callName: '  小陈 ' }).callName).toBe('小陈');
    expect(callNameValue('alex')).toBe('alex');
    expect(effectiveCallName({ account: '', callName: '' }, 'ALEX.CHEN')).toBe('Alex');
    expect(effectiveCallName({ account: 'CHEN.A', callName: '' }, 'ALEX.CHEN')).toBe('Chen');
    expect(effectiveCallName({ account: '', callName: '小陈' }, 'ALEX.CHEN')).toBe('小陈');
    expect(effectiveCallName({ account: '', callName: '' }, '')).toBe('');
  });
});

