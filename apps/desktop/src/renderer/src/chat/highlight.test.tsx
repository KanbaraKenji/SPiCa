// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MarkdownText } from './Blocks';
import { blockLanguage, HIGHLIGHT_MAX_CHARS, highlightCode } from './highlight';

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

  it('while an answer streams in, a block not closed yet stays plain (no colours changing under the reader)', () => {
    const { rerender } = render(<MarkdownText text={'看：\n\n```js\nconst a = "x'} />);
    expect(coloured()).toBe(0);
    rerender(<MarkdownText text={'看：\n\n```js\nconst a = "x";\n'} />);
    expect(coloured()).toBe(0);
    rerender(<MarkdownText text={'看：\n\n```js\nconst a = "x";\n```'} />);
    expect(coloured()).toBeGreaterThan(0);
    expect(block().textContent).toBe('const a = "x";\n');
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
