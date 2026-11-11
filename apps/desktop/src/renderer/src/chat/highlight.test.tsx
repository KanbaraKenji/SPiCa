// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MarkdownText } from './Blocks';
import { blockLanguage, colourSplit, HIGHLIGHT_MAX_CHARS, highlightCode, LIVE_MAX_LINES } from './highlight';

afterEach(cleanup);

const block = () => document.querySelector('.md pre code') as HTMLElement;
const coloured = () => document.querySelectorAll('.md pre code [class^="hl-"]').length;

describe('code colours', () => {
  it('a closed block in a registered language is coloured; its text is the code as written', () => {
    const code = "$files = Get-ChildItem 'D:\\报价' -Filter *.xlsx\n# 汇总\n$files.Count";
    render(<MarkdownText text={'```powershell\n' + code + '\n```'} />);
    expect(coloured()).toBeGreaterThan(3);
    expect(document.querySelector('.md pre .hl-comment')?.textContent).toBe('# 汇总');
    expect(block().textContent).toBe(code + '\n');
  });

  it('aliases work (ps1, bat, sh, html)', () => {
    for (const a of ['ps1', 'bat', 'sh', 'html', 'ts', 'py']) expect(blockLanguage(`language-${a}`), a).toBe(a);
  });

  it('no language, or one not registered here, stays plain text without an error', () => {
    for (const text of ['```\nconst a = 1;\n```', '```brainfuck\n+++[>++<-]\n```', '    indented code\n']) {
      render(<MarkdownText text={text} />);
      expect(coloured(), text).toBe(0);
      expect(block().textContent, text).toBe(text.startsWith('```') ? text.split('\n').slice(1, -1).join('\n') + '\n' : 'indented code\n');
      cleanup();
    }
    expect(blockLanguage('language-brainfuck')).toBeNull();
    expect(blockLanguage(undefined)).toBeNull();
  });

  it('HTML and script tags in code stay text: nothing in it becomes a real element', () => {
    const code = '<div onclick="x()"><script>alert(1)</script><img src=x onerror=alert(2)></div>';
    render(<MarkdownText text={'```html\n' + code + '\n```'} />);
    expect(coloured()).toBeGreaterThan(0);
    expect(document.querySelector('script, img, .md pre div')).toBeNull();
    expect(block().textContent).toBe(code + '\n');
    expect([...block().querySelectorAll('*')].every((el) => el.tagName === 'SPAN')).toBe(true);
  });

  it('while an answer streams in, finished lines are coloured and the line being written stays plain', () => {
    const colouredText = () => [...document.querySelectorAll('.md pre code [class^="hl-"]')].map((e) => e.textContent).join('|');
    const { rerender } = render(<MarkdownText text={'看：\n\n```js\nconst a = "x'} />);
    expect(coloured()).toBe(0);
    rerender(<MarkdownText text={'看：\n\n```js\nconst a = "x";\nlet b = "y'} />);
    expect(colouredText()).toBe('const|"x"');
    expect(block().textContent).toBe('const a = "x";\nlet b = "y\n');
    rerender(<MarkdownText text={'看：\n\n```js\nconst a = "x";\nlet b = "y";\n'} />);
    expect(colouredText()).toBe('const|"x"|let|"y"');
    rerender(<MarkdownText text={'看：\n\n```js\nconst a = "x";\nlet b = "y";\n```'} />);
    expect(colouredText()).toBe('const|"x"|let|"y"');
    expect(block().textContent).toBe('const a = "x";\nlet b = "y";\n');
  });

  it('the coloured part only grows: live up to LIVE_MAX_LINES lines, the rest once the block is closed', () => {
    const many = Array.from({ length: LIVE_MAX_LINES + 50 }, (_, i) => `x${i}`).join('\n');
    const open = colourSplit(many + '\nhalf', false);
    expect(open.done.split('\n').length - 1).toBe(LIVE_MAX_LINES);
    expect(open.done + open.rest).toBe(many + '\nhalf');
    expect(colourSplit('a\nb', false)).toEqual({ done: 'a\n', rest: 'b' });
    expect(colourSplit('a\nb\n', true)).toEqual({ done: 'a\nb\n', rest: '' });
    // Closed but over the limit: the part coloured while it streamed stays coloured, the rest plain.
    const huge = 'y\n'.repeat(HIGHLIGHT_MAX_CHARS);
    expect(colourSplit(huge, true).done.length).toBe(LIVE_MAX_LINES * 2);
  });

  it('the head shows the language as written (empty without one), and 复制', () => {
    render(<MarkdownText text={'```PowerShell\nGet-Item .\n```\n\n```\nplain\n```'} />);
    expect([...document.querySelectorAll('.code-lang')].map((e) => e.textContent)).toEqual(['PowerShell', '']);
    expect(document.querySelectorAll('.code-head button[aria-label="复制"]').length).toBe(2);
  });

  it('a long block near the limit is coloured and shown in reasonable time; past the limit it stays plain', () => {
    const lines = Array.from({ length: 1800 }, (_, i) => `const v${i} = compute("${i}", ${i} * 2); // line ${i}`).join('\n');
    expect(lines.length).toBeLessThan(HIGHLIGHT_MAX_CHARS);
    const t0 = performance.now();
    render(<MarkdownText text={'```js\n' + lines + '\n```'} />);
    const ms = performance.now() - t0;
    console.info(`1800 lines (${lines.length} chars) of JavaScript coloured and rendered in ${Math.round(ms)} ms`);
    expect(coloured()).toBeGreaterThan(5_000);
    expect(ms).toBeLessThan(5000);
    expect(highlightCode('javascript', 'x'.repeat(HIGHLIGHT_MAX_CHARS + 1))).toBeNull();
    expect(highlightCode('brainfuck', '+')).toBeNull();
  });
});
