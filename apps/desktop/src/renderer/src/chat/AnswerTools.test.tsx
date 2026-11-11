// @vitest-environment jsdom
// What an answer's code blocks, tables and file cards can do: copy, export, show in Explorer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AnswerToolsContext, FileCards, MarkdownText, type AnswerTools } from './Blocks';
import { clipboard } from '../ui/clipboard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function answer(text: string, tools: Partial<AnswerTools> | null = {}) {
  const value = tools ? { ...tools } : null;
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

  it('has the button while the answer is still streaming in (nothing jumps when it ends)', () => {
    answer('```js\nconst a =');
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
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

  it('without Explorer (no actions) it has no buttons of its own', () => {
    render(<FileCards files={[{ path: 'D:\\a.docx', tool: 'read_file' }]} onOpen={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '打开所在文件夹' })).toBeNull();
    expect(screen.queryByRole('button', { name: '复制路径' })).toBeNull();
  });
});
