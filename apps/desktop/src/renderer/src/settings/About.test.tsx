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
  render(<About version="0.1.0" update={update} ownSource="" onSource={vi.fn()} onCheck={onCheck} onInstall={vi.fn()} />);
  return onCheck;
};
const base = { current: '0.1.0', source: '', sourceFromDeploy: false, portable: false };

describe('关于 › 检查更新', () => {
  it('no update source: greyed, says to fill it in on hover, and a click does nothing', () => {
    const onCheck = show({ ...base, status: 'off', message: '未设置更新源。' });
    const button = screen.getByRole('button', { name: '检查更新' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBe('先填更新源');
    fireEvent.click(button);
    expect(onCheck).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
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
