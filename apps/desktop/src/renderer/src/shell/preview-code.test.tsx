// @vitest-environment jsdom
// The right panel shows a page, Markdown or SVG either as itself or as its code.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FilePreview } from './FilePreview';

afterEach(cleanup);

const page = '<!doctype html>\n<title>样机评审通知</title>\n<h2>通知</h2>\n<script>alert(1)</script>';

describe('the right panel: 预览 / 代码', () => {
  const html = { kind: 'html' as const, name: '样机评审通知', path: '', size: page.length, text: page, truncated: false };

  it('an HTML page switches to its code and back; a page from an answer has no file buttons', () => {
    render(<FilePreview info={html} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect([...document.querySelectorAll('.preview-head button')].map((b) => b.getAttribute('aria-label'))).toEqual(['代码', '关闭预览']);
    expect(document.querySelector('iframe.preview-html')?.getAttribute('sandbox')).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '代码' }));
    expect(document.querySelector('iframe')).toBeNull();
    expect([...document.querySelectorAll('.preview-lt')].map((l) => l.textContent)).toEqual(page.split('\n'));
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    expect(document.querySelector('iframe.preview-html')).toBeTruthy();
  });

  it('Markdown and SVG too; plain text and PDF have nothing to switch', () => {
    const { rerender } = render(<FilePreview info={{ kind: 'markdown', name: 'a.md', path: 'D:/a.md', size: 9, text: '# 标题', truncated: false }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '代码' }));
    expect(document.querySelector('.preview-lt')?.textContent).toBe('# 标题');
    rerender(<FilePreview info={{ kind: 'image', name: 'a.svg', path: 'D:/a.svg', size: 9, url: 'spica-file://f/x', text: '<svg/>' }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    // Another file opens as its preview again.
    expect(document.querySelector('.preview-image')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '代码' }));
    expect(document.querySelector('.preview-lt')?.textContent).toBe('<svg/>');
    rerender(<FilePreview info={{ kind: 'text', name: 'a.log', path: 'D:/a.log', size: 3, text: 'one', truncated: false }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '代码' })).toBeNull();
    rerender(<FilePreview info={{ kind: 'image', name: 'a.png', path: 'D:/a.png', size: 3, url: 'spica-file://f/y' }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '代码' })).toBeNull();
  });
});
