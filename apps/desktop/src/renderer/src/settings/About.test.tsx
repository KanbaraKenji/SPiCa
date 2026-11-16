// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { About } from './About';
import { dropAllDrafts } from './drafts';
import type { UpdateState } from '../../../shared/updates';

afterEach(() => {
  cleanup();
  dropAllDrafts();
});

const show = (update: UpdateState | null, onCheck = vi.fn(), onInstall = vi.fn()) => {
  render(<About version="0.1.0" update={update} onCheck={onCheck} onInstall={onInstall} whenIdle={false} onWhenIdle={vi.fn()} />);
  return onCheck;
};
const base = { current: '0.1.0', source: '', sourceFromDeploy: false, portable: false };
/** The row the version is on. */
const versionRow = () => screen.getByText('Spica 0.1.0').closest('.setting-row')!;

describe('关于 › the version, its update state and button on one row (B)', () => {
  it('no update source is shown or asked for: 检查更新 is beside the version; below only 自动更新', () => {
    show({ ...base, source: 'https://example.invalid/channel/', sourceFromDeploy: true, status: 'idle' });
    expect(screen.queryByText('更新源')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(versionRow().contains(screen.getByRole('button', { name: '检查更新' }))).toBe(true);
    expect(screen.getByRole('switch', { name: '自动更新' })).toBeTruthy();
    expect(screen.queryByText('检查更新', { selector: '.setting-title' })).toBeNull();
  });

  it('a build that checks for nothing (renamed, no source): greyed, says so on hover and beside it; a click does nothing', () => {
    const onCheck = show({ ...base, status: 'off', message: '这个版本不检查更新。' });
    const button = screen.getByRole('button', { name: '检查更新' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBe('这个版本不检查更新');
    fireEvent.click(button);
    expect(onCheck).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('这个版本不检查更新');
    // nothing would ever install itself: no 自动更新 (as a portable copy)
    expect(screen.queryByRole('switch', { name: '自动更新' })).toBeNull();
  });

  it('with a source: a click checks; while it runs it says so; then the result, without the version again', () => {
    const onCheck = show({ ...base, source: 'D:/更新', status: 'idle' });
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    expect(onCheck).toHaveBeenCalled();
    cleanup();
    show({ ...base, source: 'D:/更新', status: 'checking' });
    expect(screen.getByRole('status').textContent).toBe('正在检查更新…');
    cleanup();
    show({ ...base, source: 'D:/更新', status: 'latest', message: '已是最新版本（0.1.0）。' });
    expect(screen.getByRole('status').textContent).toBe('已是最新版本');
    expect(versionRow().contains(screen.getByRole('status'))).toBe(true);
    cleanup();
    show({ ...base, source: 'D:/更新', status: 'manual', available: '0.2.0', message: '有新版本 0.2.0（开发版不自动安装）。' });
    expect(screen.getByRole('status').textContent).toContain('有新版本 0.2.0');
  });

  it('what went wrong is a red line of its own under the row', () => {
    show({ ...base, source: 'D:/更新', status: 'error', message: '无法连接更新服务器，请检查网络后重试。' });
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('无法连接更新服务器，请检查网络后重试。');
    expect(status.className).toContain('is-bad');
    expect(versionRow().contains(status)).toBe(false);
  });

  it('downloaded: says so beside the version, and 立即更新 takes the check button’s place; waiting for tasks says that', () => {
    const onInstall = vi.fn();
    show({ ...base, source: 'D:/更新', status: 'ready', available: '0.2.1' }, vi.fn(), onInstall);
    expect(screen.getByRole('status').textContent).toBe('新版本 0.2.1 已下载');
    expect(screen.queryByRole('button', { name: '检查更新' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '立即更新' }));
    expect(onInstall).toHaveBeenCalled();
  });
});

describe('关于 › 自动更新', () => {
  it('a switch, off as given, that says when it is turned on; not in a portable copy', () => {
    const onWhenIdle = vi.fn();
    render(<About version="0.1.0" update={{ ...base, source: 'D:/更新', status: 'idle' }} onCheck={vi.fn()} onInstall={vi.fn()} whenIdle={false} onWhenIdle={onWhenIdle} />);
    const sw = screen.getByRole('switch', { name: '自动更新' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(onWhenIdle).toHaveBeenCalledWith(true);
    cleanup();
    show({ ...base, source: 'D:/更新', status: 'idle', portable: true });
    expect(screen.queryByRole('switch', { name: '自动更新' })).toBeNull();
  });
});

describe('关于 › the version switches the 监控台', () => {
  const setup = (on: boolean) => {
    const onToggle = vi.fn();
    render(<About version="0.1.0" update={null} onCheck={vi.fn()} onInstall={vi.fn()} whenIdle={false} onWhenIdle={vi.fn()} monitor={{ on, onToggle }} />);
    return { onToggle, version: screen.getByText('Spica 0.1.0') };
  };

  it('nine quick clicks switch it on, and say so; the version is plain words (not a button)', () => {
    const { onToggle, version } = setup(false);
    expect(version.closest('button')).toBeNull();
    expect(version.getAttribute('title')).toBeNull();
    for (let i = 0; i < 8; i++) fireEvent.click(version);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(version);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('监控台已开启');
  });

  it('switched on, nine more switch it off', () => {
    const { onToggle, version } = setup(true);
    for (let i = 0; i < 9; i++) fireEvent.click(version);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('监控台已关闭');
  });

  it('a pause starts the count again', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
      const { onToggle, version } = setup(false);
      for (let i = 0; i < 5; i++) fireEvent.click(version);
      vi.setSystemTime(new Date('2026-11-13T10:00:02Z'));
      for (let i = 0; i < 8; i++) fireEvent.click(version);
      expect(onToggle).not.toHaveBeenCalled();
      fireEvent.click(version);
      expect(onToggle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
