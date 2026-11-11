// @vitest-environment jsdom
// A flowchart (mermaid) code block is drawn once written and shown as a picture; code until then or if it fails.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const draw = vi.hoisted(() => ({ fn: vi.fn<(code: string, mode: string) => Promise<string>>() }));
vi.mock('./flow-draw', () => ({ drawFlow: draw.fn, pageMode: () => 'dark', svgUrl: (svg: string) => `data:image/svg+xml,${svg}` }));

import { MarkdownText } from './Blocks';

afterEach(() => {
  cleanup();
  draw.fn.mockReset();
});

const chart = 'flowchart LR\n  A --> B';

describe('a flowchart in an answer', () => {
  it('while it is being written: code, nothing drawn', () => {
    render(<MarkdownText text={'```mermaid\n' + chart} />);
    expect(draw.fn).not.toHaveBeenCalled();
    expect(document.querySelector('pre')?.textContent).toContain('A --> B');
  });

  it('once written: drawn and shown as a picture, with 代码 to see its text and 复制', async () => {
    draw.fn.mockResolvedValue('<svg>chart</svg>');
    await act(async () => {
      render(<MarkdownText text={'```mermaid\n' + chart + '\n```'} />);
    });
    expect(draw.fn).toHaveBeenCalledWith(chart, 'dark');
    expect(document.querySelector('.flow-figure img')?.getAttribute('src')).toBe('data:image/svg+xml,<svg>chart</svg>');
    expect([...document.querySelectorAll('.flow-figure .code-head button')].map((b) => b.getAttribute('aria-label'))).toEqual(['代码', '复制']);
    fireEvent.click(screen.getByRole('button', { name: '代码' }));
    expect(document.querySelector('.flow-figure pre')?.textContent).toBe(chart);
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    fireEvent.click(document.querySelector('.flow-image')!);
    expect(document.querySelector('.image-viewer')).toBeTruthy();
  });

  it('a chart that cannot be drawn stays a code block', async () => {
    draw.fn.mockRejectedValue(new Error('flow error'));
    await act(async () => {
      render(<MarkdownText text={'```mermaid\nnot a chart\n```'} />);
    });
    expect(document.querySelector('.flow-figure')).toBeNull();
    expect(document.querySelector('pre')?.textContent).toContain('not a chart');
  });
});
