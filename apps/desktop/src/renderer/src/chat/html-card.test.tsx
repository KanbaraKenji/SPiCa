// @vitest-environment jsdom
// An HTML code block in an answer is a card that opens the page in the right panel.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { AnswerToolsContext, htmlTitle, MarkdownText } from './Blocks';

afterEach(cleanup);

const page = '<!doctype html>\n<title>样机评审通知</title>\n<h2>通知</h2>\n<script>alert(1)</script>';

describe('an HTML code block in an answer', () => {
  it('is named by its title, else its first heading, else HTML', () => {
    expect(htmlTitle(page)).toBe('样机评审通知');
    expect(htmlTitle('<h2 style="x">评审 <b>通知</b></h2>')).toBe('评审 通知');
    expect(htmlTitle('<p>hi</p>')).toBe('HTML');
  });

  it('shows as a card, not code; a click opens the page; while it is still being written the card waits', () => {
    const previewHtml = vi.fn();
    const tools = { openFile: vi.fn(), openFolder: vi.fn(), previewHtml };
    const { rerender } = render(
      <AnswerToolsContext.Provider value={tools}>
        <MarkdownText text={'草稿：\n\n```html\n' + page.slice(0, 40)} />
      </AnswerToolsContext.Provider>,
    );
    expect(document.querySelector('pre')).toBeNull();
    const card = () => document.querySelector('.html-card .file-card-main') as HTMLElement;
    expect(card().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(card());
    expect(previewHtml).not.toHaveBeenCalled();
    rerender(
      <AnswerToolsContext.Provider value={tools}>
        <MarkdownText text={'草稿：\n\n```html\n' + page + '\n```'} />
      </AnswerToolsContext.Provider>,
    );
    expect(document.querySelector('.html-card .file-card-sub')?.textContent).toBe('HTML · 4 行');
    fireEvent.click(card());
    expect(previewHtml).toHaveBeenCalledWith('样机评审通知', page);
  });

  it('without a way to preview (outside a conversation) it stays a code block', () => {
    render(<MarkdownText text={'```html\n<p>hi</p>\n```'} />);
    expect(document.querySelector('pre')?.textContent).toContain('<p>hi</p>');
    expect(document.querySelector('.html-card')).toBeNull();
  });
});
