// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Appearance } from './Appearance';
import { applyPatch, DEFAULT_SETTINGS, type ShellSettings } from '../../../shared/settings';
import { resolveSkin } from '../../../shared/skin';

afterEach(cleanup);

let latest: ShellSettings = DEFAULT_SETTINGS;

function Harness() {
  const [settings, setSettings] = useState<ShellSettings>(DEFAULT_SETTINGS);
  return (
    <Appearance
      settings={settings}
      activeSkin={resolveSkin(settings.skin, false, settings.customSkins)}
      onChange={(p) => {
        latest = applyPatch(latest, p);
        setSettings(latest);
      }}
    />
  );
}

describe('Appearance', () => {
  beforeEach(() => {
    latest = DEFAULT_SETTINGS;
  });

  it('switches skins', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: /深色/ }));
    expect(latest.skin).toBe('dark');
  });

  it('creates a skin from the current one, edits its colors, and deletes it after confirming', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '新建皮肤' }));
    expect(latest.customSkins).toHaveLength(1);
    expect(latest.skin).toBe(latest.customSkins[0]?.id);

    const accent = screen.getByRole('textbox', { name: '强调色色值' });
    fireEvent.change(accent, { target: { value: '39c5bb' } });
    fireEvent.blur(accent);
    expect(latest.customSkins[0]?.accent).toBe('#39c5bb');

    const bg = screen.getByRole('textbox', { name: '底色色值' });
    fireEvent.change(bg, { target: { value: 'not a color' } });
    fireEvent.blur(bg);
    expect((bg as HTMLInputElement).value).toBe(latest.customSkins[0]?.bg);

    fireEvent.click(screen.getByRole('button', { name: /删除这个皮肤/ }));
    expect(screen.getByRole('alertdialog').textContent).toContain('删除皮肤「我的皮肤 1」？');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(latest.customSkins).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /删除这个皮肤/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(latest.customSkins).toHaveLength(0);
    expect(latest.skin).toBe('system');
  });

  it('chooses when the opening animation plays', () => {
    render(<Harness />);
    expect(screen.getByRole('radio', { name: '每天首次' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: '从不' }));
    expect(latest.splash).toBe('never');
  });

  it('zooms in steps and resets', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: '恢复 100%' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    expect(latest.zoom).toBe(1.1);
    fireEvent.click(screen.getByRole('button', { name: '恢复 100%' }));
    expect(latest.zoom).toBe(1);
  });
});
