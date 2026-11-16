// @vitest-environment jsdom
// The right panel shows a page, Markdown or SVG either as itself or as its code; code files in colour.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FilePreview } from './FilePreview';
import { HIGHLIGHT_MAX_CHARS, highlightLines } from '../chat/highlight';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const page = '<!doctype html>\n<title>样机评审通知</title>\n<h2>通知</h2>\n<script>alert(1)</script>';
const choice = () => screen.queryByRole('radiogroup', { name: '显示方式' });
const pick = (label: string) => fireEvent.click(within(choice()!).getByRole('radio', { name: label }));
const picked = () => within(choice()!).getAllByRole('radio').map((r) => `${r.textContent}:${r.getAttribute('aria-checked')}`);

describe('the right panel: 预览 / 代码', () => {
  const html = { kind: 'html' as const, name: '样机评审通知', path: '', size: page.length, text: page, truncated: false };

  it('an HTML page: 预览 / 代码 side by side in the head, 预览 first and picked; its code in colour; back again', () => {
    render(<FilePreview info={html} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    // A page from an answer has no file: no name to press, no file buttons.
    expect(document.querySelector('.preview-head button.preview-name')).toBeNull();
    expect([...document.querySelectorAll('.preview-head > button')].map((b) => b.getAttribute('aria-label'))).toEqual(['关闭预览']);
    expect(picked()).toEqual(['预览:true', '代码:false']);
    expect(document.querySelector('iframe.preview-html')?.getAttribute('sandbox')).toBe('');
    pick('代码');
    expect(picked()).toEqual(['预览:false', '代码:true']);
    expect(document.querySelector('iframe')).toBeNull();
    expect([...document.querySelectorAll('.preview-lt')].map((l) => l.textContent)).toEqual(page.split('\n'));
    // The code in a pre (the code colours are set there), coloured as HTML.
    expect(document.querySelector('pre.preview-code .hl-name')?.textContent).toBe('title');
    pick('预览');
    expect(document.querySelector('iframe.preview-html')).toBeTruthy();
  });

  it('Markdown and SVG too, each file as it was left while the panel is open; plain text and PDF have nothing to switch', () => {
    const md = { kind: 'markdown' as const, name: 'a.md', path: 'D:/a.md', size: 9, text: '# 标题', truncated: false };
    const { rerender } = render(<FilePreview info={md} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    pick('代码');
    expect(document.querySelector('.preview-lt')?.textContent).toBe('# 标题');
    expect(document.querySelector('.preview-lt .hl-section')?.textContent).toBe('# 标题');
    rerender(<FilePreview info={{ kind: 'image', name: 'a.svg', path: 'D:/a.svg', size: 9, url: 'spica-file://f/x', text: '<svg/>' }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    // Another file opens as its preview.
    expect(document.querySelector('.preview-image')).toBeTruthy();
    pick('代码');
    expect(document.querySelector('.preview-lt')?.textContent).toBe('<svg/>');
    pick('预览');
    // Back to the Markdown file: its code, as it was left.
    rerender(<FilePreview info={md} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect(picked()).toEqual(['预览:false', '代码:true']);
    rerender(<FilePreview info={{ kind: 'text', name: 'a.log', path: 'D:/a.log', size: 3, text: 'one', truncated: false }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect(choice()).toBeNull();
    rerender(<FilePreview info={{ kind: 'image', name: 'a.png', path: 'D:/a.png', size: 3, url: 'spica-file://f/y' }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect(choice()).toBeNull();
  });
});

describe('code files in colour (the colours of code in answers)', () => {
  const py = 'def total(rows):\n    """Sum\n    them."""\n    return 0  # none\n';

  it('a Python file: keywords, strings and comments coloured, a string over two lines coloured on both, numbered as before', () => {
    render(<FilePreview info={{ kind: 'text', name: 'sum.py', path: 'D:/sum.py', size: py.length, text: py, truncated: false }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    const lines = [...document.querySelectorAll('pre.preview-code .preview-line')];
    expect(lines.map((l) => l.querySelector('.preview-ln')?.textContent)).toEqual(['1', '2', '3', '4', '5']);
    expect(lines.map((l) => l.querySelector('.preview-lt')?.textContent)).toEqual(['def total(rows):', '    """Sum', '    them."""', '    return 0  # none', ' ']);
    expect(lines[0]!.querySelector('.hl-keyword')?.textContent).toBe('def');
    expect(lines[1]!.querySelector('.hl-string')?.textContent).toBe('"""Sum');
    expect(lines[2]!.querySelector('.hl-string')?.textContent).toBe('    them."""');
    expect(lines[3]!.querySelector('.hl-comment')?.textContent).toBe('# none');
  });

  it('JSON, YAML, PowerShell and others by their extension; a file of no language here stays plain', () => {
    const { rerender } = render(<FilePreview info={{ kind: 'text', name: 'a.json', path: 'D:/a.json', size: 9, text: '{"on": true}', truncated: false }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('.preview-code .hl-literal')?.textContent).toBe('true');
    rerender(<FilePreview info={{ kind: 'text', name: 'a.yml', path: 'D:/a.yml', size: 9, text: 'on: yes', truncated: false }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('.preview-code .hl-attr')?.textContent).toBe('on:');
    rerender(<FilePreview info={{ kind: 'text', name: 'a.ps1', path: 'D:/a.ps1', size: 9, text: 'Get-ChildItem # list', truncated: false }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('.preview-code .hl-comment')?.textContent).toBe('# list');
    rerender(<FilePreview info={{ kind: 'text', name: 'a.log', path: 'D:/a.log', size: 9, text: 'def x # y', truncated: false }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('.preview-code [class^="hl-"]')).toBeNull();
  });

  it('a long file shows at once in plain text, then in colour', () => {
    vi.useFakeTimers();
    const unit = 'x = 1  # one\n';
    const text = unit.repeat(Math.ceil((HIGHLIGHT_MAX_CHARS + 1) / unit.length));
    render(<FilePreview info={{ kind: 'text', name: 'long.py', path: 'D:/long.py', size: text.length, text, truncated: false }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    // Shown in pieces as before: the first 2000 lines.
    expect(document.querySelectorAll('.preview-line')).toHaveLength(2000);
    expect(document.querySelector('.preview-code .hl-comment')).toBeNull();
    act(() => vi.runAllTimers());
    expect(document.querySelector('.preview-code .hl-comment')?.textContent).toBe('# one');
  });

  it('highlightLines: one list per line, a part over a line break in each; nothing for a language not here', () => {
    const lines = highlightLines('python', 's = """a\nb"""\n')!;
    expect(lines).toHaveLength(3);
    expect(lines[2]).toEqual([]);
    expect(highlightLines('cobol', 'x')).toBeNull();
  });
});
