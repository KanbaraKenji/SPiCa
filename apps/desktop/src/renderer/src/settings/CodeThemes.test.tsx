// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CODE_THEMES, codeThemeId, codeThemesFor, codeThemeVars, SKIN_CODE_THEME } from '../../../shared/code-themes';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../../shared/settings';
import { applyCodeTheme } from '../theme';
import { CodeThemes } from './CodeThemes';

afterEach(cleanup);

describe('code themes', () => {
  it('a few well-known ones, each with what it has: light, dark or both', () => {
    expect(CODE_THEMES.map((t) => t.id)).toEqual([SKIN_CODE_THEME, 'github', 'one', 'dracula', 'solarized', 'tokyo-night', 'catppuccin']);
    expect(codeThemesFor('light').map((t) => t.id)).not.toContain('dracula');
    expect(codeThemesFor('dark').map((t) => t.id)).toContain('dracula');
    for (const t of CODE_THEMES.filter((x) => x.id !== SKIN_CODE_THEME)) expect(t.light ?? t.dark, t.id).toBeTruthy();
  });

  it('a theme that has no version for the scheme (or is unknown) falls back to the skin', () => {
    expect(codeThemeId('dracula', 'dark')).toBe('dracula');
    expect(codeThemeId('dracula', 'light')).toBe(SKIN_CODE_THEME);
    expect(codeThemeId('nope', 'dark')).toBe(SKIN_CODE_THEME);
    expect(codeThemeVars(SKIN_CODE_THEME, 'dark')).toEqual({});
    expect(codeThemeVars('github', 'dark')['--code-bg']).toBe('#0d1117');
  });

  it('settings keep a pair, the skin by default; anything odd is cleaned', () => {
    expect(DEFAULT_SETTINGS.codeTheme).toEqual({ light: SKIN_CODE_THEME, dark: SKIN_CODE_THEME });
    expect(sanitizeSettings({ codeTheme: { light: 'github', dark: 'dracula' } }).codeTheme).toEqual({ light: 'github', dark: 'dracula' });
    expect(sanitizeSettings({ codeTheme: { light: 'dracula', dark: 5 } }).codeTheme).toEqual({ light: SKIN_CODE_THEME, dark: SKIN_CODE_THEME });
    expect(sanitizeSettings({}).codeTheme).toEqual({ light: SKIN_CODE_THEME, dark: SKIN_CODE_THEME });
  });

  it('applied for the skin’s scheme; back to the skin clears it', () => {
    const root = document.createElement('div');
    applyCodeTheme({ light: 'github', dark: 'one' }, 'dark', root);
    expect(root.style.getPropertyValue('--code-bg')).toBe('#282c34');
    applyCodeTheme({ light: 'github', dark: 'one' }, 'light', root);
    expect(root.style.getPropertyValue('--code-bg')).toBe('#f6f8fa');
    applyCodeTheme({ light: SKIN_CODE_THEME, dark: SKIN_CODE_THEME }, 'light', root);
    expect(root.style.getPropertyValue('--code-bg')).toBe('');
  });
});

describe('外观 › 代码', () => {
  it('a picker for light skins and one for dark ones, each with a preview with one changed line', () => {
    const onChange = vi.fn();
    render(<CodeThemes value={{ light: SKIN_CODE_THEME, dark: 'one' }} onChange={onChange} />);
    const dark = screen.getByRole('combobox', { name: '深色代码配色' }) as HTMLSelectElement;
    expect([...dark.options].map((o) => o.textContent)).toContain('Dracula');
    expect([...dark.options].map((o) => o.textContent)).toContain('One Dark Pro');
    expect([...(screen.getByRole('combobox', { name: '浅色代码配色' }) as HTMLSelectElement).options].map((o) => o.textContent)).toContain('One Light');
    expect([...(screen.getByRole('combobox', { name: '浅色代码配色' }) as HTMLSelectElement).options].map((o) => o.textContent)).not.toContain('Dracula');
    fireEvent.change(dark, { target: { value: 'dracula' } });
    expect(onChange).toHaveBeenCalledWith({ light: SKIN_CODE_THEME, dark: 'dracula' });
    const previews = document.querySelectorAll('.code-theme-preview');
    expect(previews.length).toBe(2);
    expect((previews[1] as HTMLElement).style.getPropertyValue('--code-bg')).toBe('#282c34');
    expect(previews[1]!.querySelectorAll('.preview-del, .preview-add').length).toBe(2);
  });
});
