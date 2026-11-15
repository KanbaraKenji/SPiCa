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

const show = (update: UpdateState | null, onCheck = vi.fn()) => {
  render(<About version="0.1.0" update={update} onCheck={onCheck} onInstall={vi.fn()} whenIdle={false} onWhenIdle={vi.fn()} />);
  return onCheck;
};
const base = { current: '0.1.0', source: '', sourceFromDeploy: false, portable: false };

describe('关于 › 检查更新', () => {
  it('no update source is shown or asked for: 检查更新 is a row of its own', () => {
    show({ ...base, source: 'https://example.invalid/channel/', sourceFromDeploy: true, status: 'idle' });
    expect(screen.queryByText('更新源')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    const row = screen.getByRole('button', { name: '检查更新' }).closest('.setting-row')!;
    expect(row.querySelector('.setting-title')?.textContent).toBe('检查更新');
  });

  it('a build that checks for nothing (renamed, no source): greyed, says so on hover and in the line under it; a click does nothing', () => {
    const onCheck = show({ ...base, status: 'off', message: '这个版本不检查更新。' });
    const button = screen.getByRole('button', { name: '检查更新' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBe('这个版本不检查更新');
    fireEvent.click(button);
    expect(onCheck).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('这个版本不检查更新。');
  });

  it('with a source: a click checks; while it runs it says so; then the result', () => {
    const onCheck = show({ ...base, source: 'D:/更新', status: 'idle' });
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    expect(onCheck).toHaveBeenCalled();
    cleanup();
    show({ ...base, source: 'D:/更新', status: 'checking' });
    expect(screen.getByRole('status').textContent).toBe('正在检查更新…');
    cleanup();
    show({ ...base, source: 'D:/更新', status: 'latest', message: '已是最新版本（0.1.0）。' });
    expect(screen.getByRole('status').textContent).toBe('已是最新版本（0.1.0）。');
    cleanup();
    show({ ...base, source: 'D:/更新', status: 'manual', available: '0.2.0', message: '有新版本 0.2.0（开发版不自动安装）。' });
    expect(screen.getByRole('status').textContent).toContain('有新版本 0.2.0');
    cleanup();
    show({ ...base, source: 'D:/更新', status: 'error', message: '无法连接更新源：timeout' });
    expect(screen.getByRole('status').textContent).toBe('无法连接更新源：timeout');
  });
});

describe('关于 › 空闲时更新', () => {
  it('a switch, off as given, that says when it is turned on; not in a portable copy', () => {
    const onWhenIdle = vi.fn();
    render(<About version="0.1.0" update={{ ...base, source: 'D:/更新', status: 'idle' }} onCheck={vi.fn()} onInstall={vi.fn()} whenIdle={false} onWhenIdle={onWhenIdle} />);
    const sw = screen.getByRole('switch', { name: '空闲时更新' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(onWhenIdle).toHaveBeenCalledWith(true);
    cleanup();
    show({ ...base, source: 'D:/更新', status: 'idle', portable: true });
    expect(screen.queryByRole('switch', { name: '空闲时更新' })).toBeNull();
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
