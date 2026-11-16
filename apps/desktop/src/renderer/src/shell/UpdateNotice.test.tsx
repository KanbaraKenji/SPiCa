// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UpdateCard, UpdateRailButton, useUpdateNotice, type WaitingPlugin } from './UpdateNotice';
import type { UpdateState } from '../../../shared/updates';

afterEach(cleanup);

const base: UpdateState = { status: 'idle', current: '0.2.0', source: 'x', sourceFromDeploy: true, portable: false };

/** The side bar's place for updates: the card, or (compact) the icon; one closing state for both, as in App. */
function Place({ update, waiting = [], compact = false, onInstall = vi.fn(), onOpenPlugins = vi.fn(), onOpenSidebar = vi.fn() }: { update: UpdateState; waiting?: WaitingPlugin[]; compact?: boolean; onInstall?: () => void; onOpenPlugins?: () => void; onOpenSidebar?: () => void }) {
  const notice = useUpdateNotice(update, waiting);
  if (!notice) return null;
  return compact ? <UpdateRailButton notice={notice} onOpenSidebar={onOpenSidebar} onOpenPlugins={onOpenPlugins} /> : <UpdateCard notice={notice} onInstall={onInstall} onOpenPlugins={onOpenPlugins} />;
}

describe('updates in the side bar › the card', () => {
  it('a downloaded update: 立即更新, and 稍后 closes it', () => {
    const onInstall = vi.fn();
    render(<Place update={{ ...base, status: 'ready', available: '0.2.1' }} onInstall={onInstall} />);
    // one row: the version next to its button; the sentence in full on hover
    expect(screen.getByRole('status').textContent).toContain('新版本 0.2.1');
    expect(screen.getByTitle('新版本 0.2.1 已下载')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '立即更新' }));
    expect(onInstall).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a version that must update: the card stays (no 稍后), marked as a warning', () => {
    render(<Place update={{ ...base, status: 'ready', available: '0.2.1', required: true }} />);
    expect(screen.getByRole('status').className).toContain('is-warning');
    expect(screen.getByRole('button', { name: '立即更新' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '稍后' })).toBeNull();
  });

  it('a portable copy only hears of it; a development run hears nothing here', () => {
    render(<Place update={{ ...base, status: 'manual', available: '0.2.1', portable: true }} />);
    expect(screen.getByRole('status').textContent).toContain('新版本 0.2.1');
    expect(screen.queryByRole('button', { name: '立即更新' })).toBeNull();
    cleanup();
    render(<Place update={{ ...base, status: 'manual', available: '0.2.1' }} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('plugins that can update: 查看 opens them; closed, it comes back only when there are more', () => {
    const onOpenPlugins = vi.fn();
    const { rerender } = render(<Place update={{ ...base, status: 'latest', pluginUpdates: 2 }} onOpenPlugins={onOpenPlugins} />);
    expect(screen.getByRole('status').textContent).toContain('2 个插件可更新');
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(onOpenPlugins).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<Place update={{ ...base, status: 'latest', pluginUpdates: 1 }} onOpenPlugins={onOpenPlugins} />);
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<Place update={{ ...base, status: 'latest', pluginUpdates: 3 }} onOpenPlugins={onOpenPlugins} />);
    expect(screen.getByRole('status').textContent).toContain('3 个插件可更新');
  });

  it('the app update comes before the plugins', () => {
    render(<Place update={{ ...base, status: 'ready', available: '0.2.1', pluginUpdates: 2 }} />);
    expect(screen.getByRole('status').textContent).toContain('新版本 0.2.1');
  });
});

describe('updates in the column of icons (side bar closed or the window narrow)', () => {
  it('the app update: an icon named by its words that opens the side bar; a must-update one in warning colour', () => {
    const onOpenSidebar = vi.fn();
    render(<Place compact update={{ ...base, status: 'ready', available: '0.2.1' }} onOpenSidebar={onOpenSidebar} />);
    const b = screen.getByRole('button', { name: '新版本 0.2.1 已下载' });
    expect(b.className).not.toContain('is-warning');
    fireEvent.click(b);
    expect(onOpenSidebar).toHaveBeenCalled();
    cleanup();
    render(<Place compact update={{ ...base, status: 'ready', available: '0.2.1', required: true }} />);
    expect(screen.getByRole('button', { name: '新版本 0.2.1 已下载' }).className).toContain('is-warning');
  });

  it('plugins: the count on the icon, which opens them', () => {
    const onOpenPlugins = vi.fn();
    render(<Place compact update={{ ...base, status: 'latest', pluginUpdates: 2 }} onOpenPlugins={onOpenPlugins} />);
    const b = screen.getByRole('button', { name: '2 个插件可更新' });
    expect(b.querySelector('.rail-badge')?.textContent).toBe('2');
    fireEvent.click(b);
    expect(onOpenPlugins).toHaveBeenCalled();
  });
});

describe('plugins waiting for their settings (待设置)', () => {
  it('said where plugin updates are, before them: how many plugins; 查看 opens the plugins; closed, back only when more are missing', () => {
    const onOpenPlugins = vi.fn();
    const { rerender } = render(<Place update={{ ...base, status: 'latest', pluginUpdates: 2 }} waiting={[{ displayName: '工单查询', missing: 1 }]} onOpenPlugins={onOpenPlugins} />);
    expect(screen.getByRole('status').textContent).toContain('1 个插件待设置');
    expect(screen.getByRole('status').className).toContain('is-warning');
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(onOpenPlugins).toHaveBeenCalled();
    rerender(<Place update={{ ...base, status: 'latest' }} waiting={[{ displayName: '工单查询', missing: 1 }, { displayName: '日报', missing: 2 }]} onOpenPlugins={onOpenPlugins} />);
    expect(screen.getByRole('status').textContent).toContain('2 个插件待设置');
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('in the column of icons: the settings icon with how many plugins wait, opening the plugins', () => {
    const onOpenPlugins = vi.fn();
    render(<Place compact update={{ ...base, status: 'latest' }} waiting={[{ displayName: '工单查询', missing: 3 }]} onOpenPlugins={onOpenPlugins} />);
    fireEvent.click(screen.getByRole('button', { name: '1 个插件待设置' }));
    expect(onOpenPlugins).toHaveBeenCalled();
  });
});
