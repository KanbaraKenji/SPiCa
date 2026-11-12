// @vitest-environment jsdom
// What an answer's code blocks, tables, paths and file cards can do: copy, export, open.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AnswerToolsContext, FileCards, MarkdownText, type AnswerTools } from './Blocks';
import { clipboard } from '../ui/clipboard';

const SUMMARY = '已汇总到 `D:\\工作\\样机评审\\报价汇总.xlsx`，原始报价在 `D:\\工作\\样机评审\\报价\\`。\n\n`单价` 列先留空。';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function answer(text: string, tools: Partial<AnswerTools> | null = {}) {
  const value = tools ? { openFile: vi.fn(), openFolder: vi.fn(), ...tools } : null;
  render(
    <AnswerToolsContext.Provider value={value}>
      <MarkdownText text={text} />
    </AnswerToolsContext.Provider>,
  );
  return value;
}

describe('a code block', () => {
  it('复制 copies the code as written, without the last line break, then says 已复制', async () => {
    const write = vi.spyOn(clipboard, 'write').mockResolvedValue();
    answer('看：\n\n```powershell\n$a = 1\nWrite-Output $a\n```');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制' })));
    expect(write).toHaveBeenCalledWith('$a = 1\nWrite-Output $a');
    expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy();
  });

  it('a path inside a code block stays code (only inline code opens)', () => {
    answer('```\nD:\\工作\\样机评审\\\n```');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('has the button while the answer is still streaming in (nothing jumps when it ends)', () => {
    answer('```js\nconst a =');
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
  });
});

describe('paths in an answer', () => {
  it('a file opens in the right panel, a folder in Explorer', () => {
    const tools = answer(SUMMARY)!;
    fireEvent.click(screen.getByRole('link', { name: 'D:\\工作\\样机评审\\报价汇总.xlsx' }));
    expect(tools.openFile).toHaveBeenCalledWith('D:\\工作\\样机评审\\报价汇总.xlsx');
    const folder = screen.getByRole('link', { name: 'D:\\工作\\样机评审\\报价\\' });
    expect(folder.getAttribute('title')).toBe('打开文件夹 D:\\工作\\样机评审\\报价\\');
    fireEvent.keyDown(folder, { key: 'Enter' });
    expect(tools.openFolder).toHaveBeenCalledWith('D:\\工作\\样机评审\\报价\\');
    expect(tools.openFile).toHaveBeenCalledTimes(1);
  });

  it('a path whose last part has no extension (a file or a folder, cannot tell) shows whole; it still opens as before', () => {
    const tools = answer('资料在 `D:\\工作\\样机评审` 和 `D:\\工作\\Makefile` 里。')!;
    const a = screen.getByRole('link', { name: 'D:\\工作\\样机评审' });
    expect(a.textContent).toBe('D:\\工作\\样机评审');
    expect(screen.getByRole('link', { name: 'D:\\工作\\Makefile' }).textContent).toBe('D:\\工作\\Makefile');
    fireEvent.click(a);
    expect(tools.openFile).toHaveBeenCalledWith('D:\\工作\\样机评审');
  });

  it('shows only the name; the full path is in its hover note and in what a selection copies', () => {
    answer(SUMMARY);
    const file = screen.getByRole('link', { name: 'D:\\工作\\样机评审\\报价汇总.xlsx' });
    expect(file.textContent).toBe('报价汇总.xlsx');
    expect(file.getAttribute('title')).toBe('预览 D:\\工作\\样机评审\\报价汇总.xlsx');
    // A folder shows whole (他: 「文件夹不要省略」).
    expect(screen.getByRole('link', { name: 'D:\\工作\\样机评审\\报价\\' }).textContent).toBe('D:\\工作\\样机评审\\报价\\');
    const md = file.closest('.md')!;
    const range = document.createRange();
    range.selectNodeContents(md.querySelector('p')!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const data = new Map<string, string>();
    const copied = fireEvent.copy(md, { clipboardData: { setData: (k: string, v: string) => data.set(k, v) } });
    expect(copied).toBe(false);
    expect(data.get('text/plain')).toContain('已汇总到 D:\\工作\\样机评审\\报价汇总.xlsx，原始报价在 D:\\工作\\样机评审\\报价\\。');
    getSelection()!.removeAllRanges();
  });

  it('a selection without a path copies as the page does', () => {
    answer(SUMMARY);
    const md = document.querySelector('.md')!;
    const range = document.createRange();
    range.selectNodeContents(screen.getByText('单价', { selector: 'code' }));
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    expect(fireEvent.copy(md, { clipboardData: { setData: vi.fn() } })).toBe(true);
    getSelection()!.removeAllRanges();
  });

  it('two files of one name in different folders show the folder above (and a third level when that is the same too)', () => {
    answer('`D:\\样机\\第一版\\报价.xlsx` 和 `D:\\样机\\第二版\\报价.xlsx`，另有 `E:\\备份\\第一版\\报价.xlsx` 和 `D:\\样机\\说明.docx`');
    const names = screen.getAllByRole('link').map((l) => l.textContent);
    expect(names).toEqual(['样机\\第一版\\报价.xlsx', '第二版\\报价.xlsx', '备份\\第一版\\报价.xlsx', '说明.docx']);
  });

  it('the same path written twice is one file: both show just its name', () => {
    answer('`D:\\a\\报价.xlsx`，再看 `D:\\a\\报价.xlsx`');
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['报价.xlsx', '报价.xlsx']);
  });

  it('a full path in plain text is the same link: its name, the full path on hover, opens the same', () => {
    const tools = answer('图纸在 D:\\样机\\第一版\\报价.xlsx 里，另一版是 `D:\\样机\\第二版\\报价.xlsx`。')!;
    const plain = screen.getByRole('link', { name: 'D:\\样机\\第一版\\报价.xlsx' });
    expect(plain.tagName).toBe('CODE');
    expect(plain.className).toBe('md-path');
    expect(plain.textContent).toBe('第一版\\报价.xlsx');
    expect(plain.getAttribute('title')).toBe('预览 D:\\样机\\第一版\\报价.xlsx');
    expect(screen.getByRole('link', { name: 'D:\\样机\\第二版\\报价.xlsx' }).textContent).toBe('第二版\\报价.xlsx');
    fireEvent.click(plain);
    expect(tools.openFile).toHaveBeenCalledWith('D:\\样机\\第一版\\报价.xlsx');
    expect(plain.closest('p')!.textContent).toBe('图纸在 第一版\\报价.xlsx 里，另一版是 第二版\\报价.xlsx。');
  });

  it('a path in plain text stays plain text where nothing opens it, in a link and in a code block', () => {
    answer('在 D:\\a\\b.txt 里', null);
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.querySelector('code')).toBeNull();
    expect(document.querySelector('p')!.textContent).toBe('在 D:\\a\\b.txt 里');
    cleanup();
    answer('[D:\\a\\b.txt](https://example.com/b) 和\n\n```\nD:\\a\\c.txt\n```');
    expect(screen.getByRole('link').textContent).toBe('D:\\a\\b.txt');
    expect(document.querySelector('pre')!.textContent).toContain('D:\\a\\c.txt');
    expect(document.querySelector('.md-path')).toBeNull();
  });

  it('other inline code stays plain code', () => {
    answer(SUMMARY);
    const code = screen.getByText('单价', { selector: 'code' });
    expect(code.getAttribute('role')).toBeNull();
    expect(code.className).toBe('');
  });

  it('where nothing can open them, paths are plain code too', () => {
    answer('在 `D:\\工作\\a.xlsx`', null);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('D:\\工作\\a.xlsx').tagName).toBe('CODE');
  });

  it('a network path opens only inside the working folder; another host stays plain code', () => {
    const tools = answer('`\\\\files\\proj\\报价.xlsx` 和 `\\\\evil.example.com\\s\\a.xlsx`', { cwd: '\\\\files\\proj' })!;
    fireEvent.click(screen.getByRole('link', { name: '\\\\files\\proj\\报价.xlsx' }));
    expect(tools.openFile).toHaveBeenCalledWith('\\\\files\\proj\\报价.xlsx');
    const other = screen.getByText('\\\\evil.example.com\\s\\a.xlsx');
    expect(other.getAttribute('role')).toBeNull();
    fireEvent.click(other);
    expect(tools.openFile).toHaveBeenCalledTimes(1);
  });
});

describe('a table', () => {
  const table = '| 供应商 | 单价 |\n|---|---|\n| 华东精密 | 128.50 |\n| 启明, 电子 | 131.00 |';

  it('复制 puts tab-separated text and an HTML table on the clipboard (pastes into Excel as cells)', async () => {
    const rich = vi.spyOn(clipboard, 'writeRich').mockResolvedValue();
    answer(table);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制' })));
    expect(rich).toHaveBeenCalledWith('供应商\t单价\r\n华东精密\t128.50\r\n启明, 电子\t131.00', expect.stringContaining('<th>供应商</th>'));
  });

  it('导出 CSV hands the CSV over and says 已导出 once it was saved', async () => {
    const saveCsv = vi.fn().mockResolvedValue(true);
    answer(table, { saveCsv });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '导出 CSV' })));
    expect(saveCsv).toHaveBeenCalledWith('供应商,单价\r\n华东精密,128.50\r\n"启明, 电子",131.00\r\n');
    expect(screen.getByRole('button', { name: '已导出' })).toBeTruthy();
  });

  it('a cancelled save leaves it as it was; without a way to save there is no 导出 CSV', async () => {
    const saveCsv = vi.fn().mockResolvedValue(false);
    answer(table, { saveCsv });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '导出 CSV' })));
    expect(screen.getByRole('button', { name: '导出 CSV' })).toBeTruthy();
    cleanup();
    answer(table);
    expect(screen.queryByRole('button', { name: '导出 CSV' })).toBeNull();
  });
});

describe('a file card', () => {
  it('打开所在文件夹 and 复制路径 use the full path (a relative one in the working folder); the card still opens the file', async () => {
    const write = vi.spyOn(clipboard, 'write').mockResolvedValue();
    const reveal = vi.fn();
    const onOpen = vi.fn();
    render(<FileCards files={[{ path: '资料\\需求说明.docx', tool: 'read_file' }]} onOpen={onOpen} actions={{ reveal, cwd: 'D:\\工作\\样机评审' }} />);
    fireEvent.click(screen.getByRole('button', { name: '打开所在文件夹' }));
    expect(reveal).toHaveBeenCalledWith('D:\\工作\\样机评审\\资料\\需求说明.docx');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制路径' })));
    expect(write).toHaveBeenCalledWith('D:\\工作\\样机评审\\资料\\需求说明.docx');
    fireEvent.click(screen.getByRole('button', { name: /需求说明\.docx/ }));
    expect(onOpen).toHaveBeenCalledWith('资料\\需求说明.docx');
  });

  it('says what the round did with the file, with the lines added and removed', () => {
    const at = '2026-11-11T20:00:00+08:00';
    const made = { path: 'D:\\w\\q5.py', name: 'q5.py', kind: 'text' as const, sizeBytes: 9, modifiedAt: at, extractedAt: at, read: {}, origin: 'modified' as const };
    render(<FileCards files={[{ path: made.path, tool: 'edit_file', card: made, lines: { added: 3, removed: 1 } }]} onOpen={vi.fn()} />);
    const sub = document.querySelector('.file-card-sub')!;
    expect(sub.textContent).toBe('Edited +3 −1');
    expect(sub.querySelector('.file-lines-added')?.textContent).toBe(' +3');
    expect(sub.querySelector('.file-lines-removed')?.textContent).toBe(' −1');
  });

  it('many cards (a command can report 20): six, then 全部 N 个; 收起 folds them again', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ path: `D:\\w\\out-${i}.csv`, tool: 'run_command' }));
    render(<FileCards files={many} onOpen={vi.fn()} />);
    expect(document.querySelectorAll('.file-card').length).toBe(6);
    fireEvent.click(screen.getByRole('button', { name: '全部 20 个' }));
    expect(document.querySelectorAll('.file-card').length).toBe(20);
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(document.querySelectorAll('.file-card').length).toBe(6);
    cleanup();
    // Seven fit as they are: folding would save only one card's room.
    render(<FileCards files={many.slice(0, 7)} onOpen={vi.fn()} />);
    expect(document.querySelectorAll('.file-card').length).toBe(7);
    expect(screen.queryByRole('button', { name: /全部/ })).toBeNull();
  });

  it('a picture file shows itself, small, in place of its type badge; anything else (or a picture that cannot load) keeps the badge', async () => {
    const imageUrl = vi.fn(async (p: string) => `spica-file://f/${encodeURIComponent(p)}`);
    await act(async () => {
      render(
        <FileCards
          files={[
            { path: 'D:\\w\\报价对比图.png', tool: 'charts__render' },
            { path: 'D:\\w\\导出.zip', tool: 'charts__render' },
          ]}
          onOpen={vi.fn()}
          actions={{ reveal: vi.fn(), imageUrl }}
        />,
      );
    });
    const pictures = document.querySelectorAll('.file-card-picture');
    expect(pictures.length).toBe(1);
    expect(pictures[0]!.getAttribute('src')).toBe(`spica-file://f/${encodeURIComponent('D:\\w\\报价对比图.png')}`);
    expect(imageUrl).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.error(pictures[0]!));
    expect(document.querySelectorAll('.file-card-picture').length).toBe(0);
    expect(document.querySelectorAll('.file-card-icon').length).toBe(2);
  });

  it('without Explorer (no actions) it has no buttons of its own', () => {
    render(<FileCards files={[{ path: 'D:\\a.docx', tool: 'read_file' }]} onOpen={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '打开所在文件夹' })).toBeNull();
    expect(screen.queryByRole('button', { name: '复制路径' })).toBeNull();
  });
});
