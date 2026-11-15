// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ForcedUpdate } from './ForcedUpdate';
import type { UpdateState } from '../../../shared/updates';

afterEach(cleanup);

const base: UpdateState = { status: 'downloading', current: '0.2.0', available: '0.3.0', source: 'x', sourceFromDeploy: true, portable: false, required: true, forcing: true };

describe('a version that must update, found at start', () => {
  it('nothing unless it is forced', () => {
    render(<ForcedUpdate update={{ ...base, forcing: false }} onRetry={vi.fn()} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('while it downloads: 正在更新到 x and how far, nothing to press', () => {
    render(<ForcedUpdate update={{ ...base, progress: 0.42 }} onRetry={vi.fn()} />);
    expect(screen.getByRole('alertdialog').querySelector('.dialog-title')!.textContent).toBe('正在更新到 0.3.0');
    expect((document.querySelector('.plugin-progress-bar > span') as HTMLElement).style.width).toBe('42%');
    expect(document.querySelector('.forced-update-pct')!.textContent).toBe('42%');
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('downloaded: 正在安装 x (the app restarts into it)', () => {
    render(<ForcedUpdate update={{ ...base, status: 'ready' }} onRetry={vi.fn()} />);
    expect(document.querySelector('.dialog-title')!.textContent).toBe('正在安装 0.3.0');
  });

  it('failed: the reason, 重试 checks again, 稍后 lets the app be used', () => {
    const onRetry = vi.fn();
    render(<ForcedUpdate update={{ ...base, status: 'error', message: '无法连接更新服务器，请检查网络后重试。' }} onRetry={onRetry} />);
    expect(document.querySelector('.dialog-title')!.textContent).toBe('更新失败');
    expect(document.querySelector('.dialog-detail')!.textContent).toBe('无法连接更新服务器，请检查网络后重试。');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
