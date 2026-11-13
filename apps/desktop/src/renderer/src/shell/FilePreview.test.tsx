// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FilePreview } from './FilePreview';
import { clipboard } from '../ui/clipboard';
import { optionLabels, pickValue, valueOf } from '../ui/select-testing';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FilePreview', () => {
  it('numbers the lines of a text file and says when it was cut', () => {
    render(<FilePreview info={{ kind: 'text', name: 'a.log', path: 'D:/a.log', size: 600_000, text: 'one\ntwo', truncated: true }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('two')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText(/仅显示前 512 KB（共 /)).toBeTruthy();
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

describe('the expand button in the preview head', () => {
  const info = { kind: 'text' as const, name: 'a.log', path: 'D:/a.log', size: 7, text: 'one', truncated: false };
  it('sits left of 用系统程序打开, then 关闭预览; a press toggles, and it reads 还原 while expanded', () => {
    const toggle = vi.fn();
    const { rerender } = render(<FilePreview info={info} onOpenExternal={vi.fn()} onClose={vi.fn()} max={{ on: false, toggle }} />);
    const head = document.querySelector('.preview-head') as HTMLElement;
    expect([...head.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['最大化', '复制路径', '用系统程序打开', '关闭预览']);
    const max = screen.getByRole('button', { name: '最大化' });
    expect(max.getAttribute('aria-pressed')).toBe('false');
    expect(max.getAttribute('title')).toBe('最大化（Ctrl+Shift+\\）');
    fireEvent.click(max);
    expect(toggle).toHaveBeenCalledTimes(1);
    rerender(<FilePreview info={info} onOpenExternal={vi.fn()} onClose={vi.fn()} max={{ on: true, toggle }} />);
    expect(screen.getByRole('button', { name: '还原' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('without it (nothing to expand) the head has only its own two buttons', () => {
    render(<FilePreview info={info} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect([...document.querySelectorAll('.preview-head button')].map((b) => b.getAttribute('aria-label'))).toEqual(['复制路径', '用系统程序打开', '关闭预览']);
  });
});

describe('the file’s place, from the preview head', () => {
  const info = { kind: 'text' as const, name: '报价汇总.csv', path: 'D:\\工作\\报价汇总.csv', size: 7, text: 'a', truncated: false };
  it('打开所在文件夹 and 复制路径 before 用系统程序打开, with the full path', async () => {
    const write = vi.spyOn(clipboard, 'write').mockResolvedValue();
    const onReveal = vi.fn();
    render(<FilePreview info={info} onOpenExternal={vi.fn()} onReveal={onReveal} onClose={vi.fn()} />);
    expect([...document.querySelectorAll('.preview-head button')].map((b) => b.getAttribute('aria-label'))).toEqual(['打开所在文件夹', '复制路径', '用系统程序打开', '关闭预览']);
    fireEvent.click(screen.getByRole('button', { name: '打开所在文件夹' }));
    expect(onReveal).toHaveBeenCalledWith('D:\\工作\\报价汇总.csv');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制路径' })));
    expect(write).toHaveBeenCalledWith('D:\\工作\\报价汇总.csv');
  });
  it('not for a file that is not there', () => {
    render(<FilePreview info={{ kind: 'missing', name: 'x.txt', path: 'D:/x.txt', size: 0, message: '找不到文件。' }} onOpenExternal={vi.fn()} onReveal={vi.fn()} onClose={vi.fn()} />);
    expect([...document.querySelectorAll('.preview-head button')].map((b) => b.getAttribute('aria-label'))).toEqual(['关闭预览']);
  });

  it('an Excel sheet: a tab per sheet, the grid with column letters and row numbers, and a note when cut', () => {
    const onSheet = vi.fn();
    const info = {
      kind: 'sheet' as const,
      name: '库存.xlsx',
      path: 'D:/库存.xlsx',
      size: 9000,
      sheets: [{ name: '库存', rows: 900, cols: 2 }, { name: '进货记录', rows: 3, cols: 4 }],
      sheet: 1,
      columns: ['A', 'B'],
      rows: [{ n: 1, cells: ['品名', '数量'] }, { n: 2, cells: ['键盘', '150'] }],
      truncated: true,
    };
    render(<FilePreview info={info} onOpenExternal={vi.fn()} onSheet={onSheet} onClose={vi.fn()} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['库存', '进货记录']);
    fireEvent.click(screen.getByRole('tab', { name: '进货记录' }));
    expect(onSheet).toHaveBeenCalledWith(2);
    expect([...document.querySelectorAll('.preview-sheet thead th')].map((t) => t.textContent)).toEqual(['', 'A', 'B']);
    expect([...document.querySelectorAll('.preview-sheet tbody tr')].map((r) => r.textContent)).toEqual(['1品名数量', '2键盘150']);
    expect(screen.getByText('仅显示前 2 行（共 900 行）')).toBeTruthy();
    // Not a file with code of its own.
    expect(screen.queryByRole('button', { name: '代码' })).toBeNull();
  });

  it('a Word document is shown as its text, says where it was cut, and has no 代码 view', () => {
    render(<FilePreview info={{ kind: 'markdown', name: '纪要.docx', path: 'D:/纪要.docx', size: 9000, text: '# 纪要', truncated: true }} onOpenExternal={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '纪要' })).toBeTruthy();
    expect(screen.getByText('仅显示前 500 段')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '代码' })).toBeNull();
  });

  it('预览方式: the app’s own or a plugin page, for this file; a plugin page fills the body; a line says why the app’s own is back, with 重试', () => {
    const onChange = vi.fn();
    const onRetry = vi.fn();
    const info = { kind: 'unsupported' as const, name: '需求说明.docx', path: 'D:/需求说明.docx', size: 0, message: '' };
    const source = { options: [{ id: '', label: '自带预览' }, { id: 'office-preview/docx', label: 'Word 原样预览' }], value: 'office-preview/docx', onChange };
    const { rerender } = render(
      <FilePreview info={info} onOpenExternal={vi.fn()} onClose={vi.fn()} source={source}>
        <div data-testid="page" />
      </FilePreview>,
    );
    const select = screen.getByRole('combobox', { name: '预览方式' });
    expect(optionLabels(select)).toEqual(['自带预览', 'Word 原样预览']);
    expect(valueOf(select)).toBe('office-preview/docx');
    expect(screen.getByTestId('page')).toBeTruthy();
    expect(screen.getByRole('button', { name: '用系统程序打开' })).toBeTruthy();
    pickValue(select, '');
    expect(onChange).toHaveBeenCalledWith('');
    rerender(<FilePreview info={{ kind: 'markdown', name: '需求说明.docx', path: 'D:/需求说明.docx', size: 9, text: '# 需求', truncated: false }} onOpenExternal={vi.fn()} onClose={vi.fn()} source={{ ...source, value: 'office-preview/docx' }} note={{ text: '「Word 原样预览」打开超时', onRetry }} />);
    expect(screen.getByText('「Word 原样预览」打开超时')).toBeTruthy();
    expect(screen.queryByTestId('page')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('no 预览方式 when only the app’s own can show the file', () => {
    render(<FilePreview info={{ kind: 'text', name: 'a.log', path: 'D:/a.log', size: 3, text: 'one', truncated: false }} onOpenExternal={vi.fn()} onClose={vi.fn()} source={{ options: [{ id: '', label: '自带预览' }], value: '', onChange: vi.fn() }} />);
    expect(screen.queryByRole('combobox', { name: '预览方式' })).toBeNull();
  });
});
