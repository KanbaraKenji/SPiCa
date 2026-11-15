// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NoticeBar } from './NoticeBar';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import type { UpdateState } from '../../../shared/updates';

afterEach(cleanup);

const base: UpdateState = { status: 'idle', current: '0.2.0', source: 'x', sourceFromDeploy: true, portable: false };
const bar = (update: UpdateState, more: { onInstall?: () => void; onOpenPlugins?: () => void } = {}) =>
  render(<NoticeBar update={update} settings={DEFAULT_SETTINGS} onInstall={more.onInstall ?? vi.fn()} onOpenPlugins={more.onOpenPlugins ?? vi.fn()} onDismissNotice={vi.fn()} />);

describe('NoticeBar › updates', () => {
  it('a downloaded update: 重启并更新, and 稍后 closes it', () => {
    const onInstall = vi.fn();
    bar({ ...base, status: 'ready', available: '0.2.1' }, { onInstall });
    expect(screen.getByRole('status').textContent).toContain('新版本 0.2.1 已下载');
    fireEvent.click(screen.getByRole('button', { name: '重启并更新' }));
    expect(onInstall).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a version that must update: the line stays (no 稍后), marked as a warning', () => {
    bar({ ...base, status: 'ready', available: '0.2.1', required: true });
    const line = screen.getByRole('status');
    expect(line.className).toContain('is-warning');
    expect(screen.getByRole('button', { name: '重启并更新' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '稍后' })).toBeNull();
  });

  it('a portable copy only hears of it: no 重启并更新', () => {
    bar({ ...base, status: 'manual', available: '0.2.1', portable: true });
    expect(screen.getByRole('status').textContent).toContain('新版本 0.2.1');
    expect(screen.queryByRole('button', { name: '重启并更新' })).toBeNull();
    cleanup();
    // A development run hears nothing here (设置 › 关于 says it).
    bar({ ...base, status: 'manual', available: '0.2.1' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('plugins that can update: 查看 opens them; closed, it comes back only when there are more', () => {
    const onOpenPlugins = vi.fn();
    const { rerender } = bar({ ...base, status: 'latest', pluginUpdates: 2 }, { onOpenPlugins });
    expect(screen.getByRole('status').textContent).toContain('2 个插件可更新');
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(onOpenPlugins).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    expect(screen.queryByRole('status')).toBeNull();
    const again = (n: number) => rerender(<NoticeBar update={{ ...base, status: 'latest', pluginUpdates: n }} settings={DEFAULT_SETTINGS} onInstall={vi.fn()} onOpenPlugins={onOpenPlugins} onDismissNotice={vi.fn()} />);
    again(1);
    expect(screen.queryByRole('status')).toBeNull();
    again(3);
    expect(screen.getByRole('status').textContent).toContain('3 个插件可更新');
  });

  it('the app update comes before the plugins', () => {
    bar({ ...base, status: 'ready', available: '0.2.1', pluginUpdates: 2 });
    expect(screen.getByRole('status').textContent).toContain('新版本 0.2.1');
  });
});
