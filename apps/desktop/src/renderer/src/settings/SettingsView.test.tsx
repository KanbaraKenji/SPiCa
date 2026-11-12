// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SettingsView, type SettingsViewProps } from './SettingsView';
import { ShellStore } from '../store/shell';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import type { DesktopBridge } from '../../../shared/bridge';
import { dropAllDrafts } from './drafts';

afterEach(() => {
  cleanup();
  dropAllDrafts();
});

function show(over: Partial<SettingsViewProps> = {}) {
  const bridge = { onSettingsChanged: () => () => {}, updateSettings: async () => {} } as unknown as DesktopBridge;
  const shell = new ShellStore(bridge, { settings: DEFAULT_SETTINGS, demo: false, systemDark: false } as never);
  const props: SettingsViewProps = {
    shell,
    providers: {} as never,
    plugins: {} as never,
    version: '0.1.0',
    update: null,
    onCheckUpdate: vi.fn(),
    onInstallUpdate: vi.fn(),
    tab: 'about',
    onTab: vi.fn(),
    onClose: vi.fn(),
    workflows: { run: async () => ({ dir: '', names: [], problems: [] }) } as never,
    pickFolder: async () => null,
    onBackendRestarted: () => () => {},
    projects: [],
    exportUsageLog: async () => null,
    showInFolder: vi.fn(),
    ...over,
  };
  render(<SettingsView {...props} />);
  return props;
}

describe('设置 as a dialog over the window', () => {
  it('a dialog named 设置: the sections in a column, the one shown picked; no way back arrow', () => {
    const p = show();
    const dialog = screen.getByRole('dialog', { name: '设置' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const nav = within(dialog).getByRole('tablist', { name: '设置' });
    expect(nav.getAttribute('aria-orientation')).toBe('vertical');
    // No memory kept by the core: no 记忆.
    expect(within(nav).getAllByRole('tab').map((t) => t.textContent)).toEqual(['常规', '账号', '外观', '模型', '插件', '关于']);
    expect(within(nav).getByRole('tab', { name: '关于' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('button', { name: '返回对话' })).toBeNull();
    fireEvent.click(within(nav).getByRole('tab', { name: '外观' }));
    expect(p.onTab).toHaveBeenCalledWith('appearance');
    // Its own scrim: the caption buttons dim with it (ui/dim.ts counts every .scrim).
    expect(dialog.parentElement?.classList.contains('scrim')).toBe(true);
  });

  it('closes by its close button and by a press outside it; a press inside does not close it', () => {
    const p = show();
    const dialog = screen.getByRole('dialog', { name: '设置' });
    fireEvent.mouseDown(dialog);
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog.parentElement!);
    expect(p.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }));
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });

  it('the keyboard starts in the dialog, not on a section (no ring until Tab)', () => {
    show();
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '设置' }));
  });
});
