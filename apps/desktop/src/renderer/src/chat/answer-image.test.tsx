// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { AnswerToolsContext, MarkdownText } from './Blocks';
import { imageSource } from './answer-image';

afterEach(cleanup);

const LOCAL = '![四家报价对比](<D:\\工作\\图\\quote-chart.png>)';

describe('pictures in an answer', () => {
  it('where a picture comes from', () => {
    expect(imageSource('D:\\工作\\a.png')).toEqual({ kind: 'local', path: 'D:\\工作\\a.png' });
    expect(imageSource('file:///D:/工作/a%201.png')).toEqual({ kind: 'local', path: 'D:\\工作\\a 1.png' });
    expect(imageSource('https://example.com/a.png')).toEqual({ kind: 'web', url: 'https://example.com/a.png', host: 'example.com' });
    expect(imageSource('a.png', 'D:\\工作')).toEqual({ kind: 'local', path: 'D:\\工作\\a.png' });
    // As Markdown hands it over: percent-encoded.
    expect(imageSource('D:%5C%E5%B7%A5%E4%BD%9C%5Ca.png')).toEqual({ kind: 'local', path: 'D:\\工作\\a.png' });
    expect(imageSource('%5C%5Cfiles%5Cproj%5Ca.png').kind).toBe('blocked');
    for (const s of ['\\\\files\\proj\\a.png', '//files/proj/a.png', 'file://files/proj/a.png', 'http://example.com/a.png', 'javascript:alert(1)', 'D:\\工作\\a.exe', 'a.png'])
      expect(imageSource(s).kind, s).toBe('blocked');
  });

  it('a local picture shows, also when the answer streamed in piece by piece', async () => {
    const imageUrl = vi.fn(async (p: string) => `spica-file://f/${encodeURIComponent(p)}`);
    const tools = { openFile: vi.fn(), openFolder: vi.fn(), imageUrl, webImages: 'click' as const };
    const text = `对比如下：\n\n${LOCAL}\n\n完。`;
    const { rerender } = render(
      <AnswerToolsContext.Provider value={tools}>
        <MarkdownText text="" />
      </AnswerToolsContext.Provider>,
    );
    for (let n = 3; n <= text.length; n += 3)
      await act(async () =>
        rerender(
          <AnswerToolsContext.Provider value={tools}>
            <MarkdownText text={text.slice(0, n)} />
          </AnswerToolsContext.Provider>,
        ),
      );
    await act(async () =>
      rerender(
        <AnswerToolsContext.Provider value={tools}>
          <MarkdownText text={text} />
        </AnswerToolsContext.Provider>,
      ),
    );
    const img = document.querySelector('.md img');
    expect(img?.getAttribute('src')).toBe(`spica-file://f/${encodeURIComponent('D:\\工作\\图\\quote-chart.png')}`);
  });
});
