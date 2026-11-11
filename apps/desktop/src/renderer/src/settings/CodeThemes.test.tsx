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
    expect(CODE_THEMES.map((t) => t.id)).toEqual([SKIN_CODE_THEME, 'claude', 'github', 'one', 'dracula', 'solarized', 'tokyo-night', 'catppuccin']);
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

describe('Claude 风格', () => {
  it('the Claude app’s colours, one per kind of code element, on the skin’s own code background', () => {
    const dark = codeThemeVars('claude', 'dark');
    expect(dark).not.toHaveProperty('--code-bg');
    expect(dark).toMatchObject({
      '--code-fg': 'hsl(220, 15%, 93%)',
      '--hl-keyword': 'hsl(280, 85%, 72%)',
      '--hl-built-in': 'hsl(280, 85%, 72%)',
      '--hl-language': 'hsl(280, 85%, 72%)',
      '--hl-function': 'hsl(210, 100%, 72%)',
      '--hl-params': 'hsl(30, 90%, 67%)',
      '--hl-property': 'hsl(355, 85%, 72%)',
      '--hl-attr': 'hsl(355, 85%, 72%)',
      '--hl-attr-name': 'hsl(355, 80%, 70%)',
      '--hl-regex': 'hsl(95, 70%, 63%)',
      '--hl-punctuation': 'hsl(220, 15%, 85%)',
      // Everything else in the text colour.
      '--hl-title': 'hsl(220, 15%, 93%)',
      '--hl-type': 'hsl(220, 15%, 93%)',
      '--hl-literal': 'hsl(220, 15%, 93%)',
    });
    expect(codeThemeVars('claude', 'light')['--hl-function']).toBe('hsl(215, 100%, 38%)');
    // The other themes set none of the finer parts: those keep their group's colour.
    expect(Object.keys(codeThemeVars('github', 'dark'))).not.toContain('--hl-function');
  });

  it('named the same in both lists; its preview shows the light or dark skin’s background, whatever skin is on', () => {
    render(<CodeThemes value={{ light: 'claude', dark: 'claude' }} onChange={vi.fn()} />);
    for (const name of ['浅色代码配色', '深色代码配色']) {
      const sel = screen.getByRole('combobox', { name }) as HTMLSelectElement;
      expect(sel.selectedOptions[0]?.textContent).toBe('Claude 风格');
    }
    const [light, dark] = [...document.querySelectorAll('.code-theme-preview')] as HTMLElement[];
    expect(light!.style.getPropertyValue('--code-bg')).not.toBe(dark!.style.getPropertyValue('--code-bg'));
    expect(light!.style.getPropertyValue('--code-bg')).toBeTruthy();
    expect(dark!.style.getPropertyValue('--hl-function')).toBe('hsl(210, 100%, 72%)');
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
