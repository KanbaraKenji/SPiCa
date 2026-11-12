// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SettingsView, type SettingsViewProps } from './SettingsView';
import { ShellStore } from '../store/shell';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import type { DesktopBridge } from '../../../shared/bridge';
import { dropAllDrafts } from './drafts';
import { FakePluginService } from '../../../main/plugins/fake';

const fakePlugins = new FakePluginService('D:/Spica/plugins');

afterEach(() => {
  cleanup();
  dropAllDrafts();
});

function show(over: Partial<SettingsViewProps> = {}) {
  const bridge = { onSettingsChanged: () => () => {}, updateSettings: async () => {} } as unknown as DesktopBridge;
  const shell = new ShellStore(bridge, { settings: DEFAULT_SETTINGS, demo: false, systemDark: false } as never);
  const props: SettingsViewProps = {
    shell,
    // Searching renders every section, so each needs what it reads when it opens.
    providers: { list: async () => ({ items: [], problems: {} }) } as never,
    plugins: { run: (cmd) => fakePlugins.run(cmd), onChanged: () => () => {} },
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
    const nav = within(dialog).getByRole('tablist', { name: '分区' });
    expect(nav.getAttribute('aria-orientation')).toBe('vertical');
    // In groups split by a line, no group names (as Claude's); no memory kept by the core: no 记忆.
    expect([...nav.querySelectorAll('.settings-nav-group')].map((g) => [...g.querySelectorAll('[role=tab]')].map((t) => t.textContent))).toEqual([['账号'], ['常规', '外观'], ['模型', '插件'], ['关于']]);
    // Each with its mark before the name.
    expect(within(nav).getAllByRole('tab').every((t) => t.querySelector('svg.settings-nav-icon'))).toBe(true);
    // The title bar says 设置; the section's name heads its content.
    expect(within(dialog).getByRole('heading', { level: 2 }).textContent).toBe('设置');
    expect(within(dialog).getByRole('heading', { level: 3, name: '关于' })).toBeTruthy();
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

describe('搜索设置', () => {
  it('lists the rows that match by section; one goes to its section and marks it; nothing found says so', async () => {
    const p = show({ tab: 'about' });
    const box = screen.getByLabelText('搜索设置');
    fireEvent.change(box, { target: { value: '更新源' } });
    expect(screen.getByRole('heading', { level: 3, name: '搜索结果' })).toBeTruthy();
    const about = screen.getByRole('region', { name: '关于' });
    const hit = within(about).getByRole('button', { name: /更新源/ });
    expect(hit.textContent).toBe('更新与公告 › 更新源');
    // No section is picked while searching.
    expect(screen.getAllByRole('tab').every((t) => t.getAttribute('aria-selected') === 'false')).toBe(true);
    fireEvent.click(hit);
    expect(p.onTab).toHaveBeenCalledWith('about');
    expect((box as HTMLInputElement).value).toBe('');
    fireEvent.change(box, { target: { value: '没有这一项' } });
    expect(screen.getByText('没有找到相关设置')).toBeTruthy();
    expect(document.querySelectorAll('.search-hit')).toHaveLength(0);
  });

  it('a section’s name finds all of it', () => {
    show({ tab: 'about' });
    fireEvent.change(screen.getByLabelText('搜索设置'), { target: { value: '账号' } });
    const account = screen.getByRole('region', { name: '账号' });
    expect(within(account).getAllByRole('button').map((b) => b.querySelector('.search-hit-title')?.textContent)).toEqual(['账号', '昵称']);
  });
});
});
