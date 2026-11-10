// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FilePreview } from './FilePreview';

afterEach(cleanup);

describe('FilePreview', () => {
  it('numbers the lines of a text file and says when it was cut', () => {
    render(<FilePreview info={{ kind: 'text', name: 'a.log', path: 'D:/a.log', size: 600_000, text: 'one\ntwo', truncated: true }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('two')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText(/只显示前 512 KB/)).toBeTruthy();
  });

  it('shows HTML in a sandbox with no permissions, and opens with Windows on request', () => {
    const onOpenExternal = vi.fn();
    const onClose = vi.fn();
    render(<FilePreview info={{ kind: 'html', name: 'p.html', path: 'D:/p.html', size: 30, text: '<h1>hi</h1><script>alert(1)</script>', truncated: false }} onOpenExternal={onOpenExternal} onClose={onClose} />);
    const frame = screen.getByTitle('p.html');
    expect(frame.getAttribute('sandbox')).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '用系统程序打开' }));
    expect(onOpenExternal).toHaveBeenCalledWith('D:/p.html');
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders Markdown, and says so for files it cannot show', () => {
    render(<FilePreview info={{ kind: 'markdown', name: 'a.md', path: 'D:/a.md', size: 9, text: '# 标题\n\n正文', truncated: false }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '标题' })).toBeTruthy();
    cleanup();
    render(<FilePreview info={{ kind: 'missing', name: 'x.txt', path: 'D:/x.txt', size: 0, message: '找不到文件，可能已被移动或删除。' }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/找不到文件/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '用系统程序打开' })).toBeNull();
  });
});
