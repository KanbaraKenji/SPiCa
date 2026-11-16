import { describe, expect, it, vi } from 'vitest';
import type { PluginView } from '../../../shared/plugin-view';
import { pressFile, type FilePress } from './open-file';

const how = (over: Partial<FilePress> = {}): FilePress => ({
  pages: [],
  open: vi.fn(async () => null),
  preview: vi.fn(),
  notice: vi.fn(),
  ...over,
});

describe('a press on a file', () => {
  it('PowerPoint and the old Word and Excel formats open in their system program, not in the preview', () => {
    for (const name of ['D:/评审/周报.pptx', 'D:/旧/汇报.PPT', 'D:/a.ppsx', 'D:/旧/合同.doc', 'D:/旧/台账.XLS']) {
      const h = how();
      expect(pressFile(name, h)).toBe('system');
      expect(h.open).toHaveBeenCalledWith(name);
      expect(h.preview).not.toHaveBeenCalled();
    }
  });

  it('other files open in the preview, pictures too (as Claude: big on a press there), and the ones it cannot show (they say so there)', () => {
    for (const name of ['D:/图/横幅.png', 'D:/图/流程.svg', 'D:/a.docx', 'D:/a.xlsx', 'D:/a.csv', 'D:/a.zip', 'D:/a.mp4', 'D:/a.avif', 'D:/a.dwg', 'D:/LICENSE']) {
      const h = how();
      expect(pressFile(name, h)).toBe('preview');
      expect(h.preview).toHaveBeenCalledWith(name);
      expect(h.open).not.toHaveBeenCalled();
    }
  });

  it('a plugin preview page for the kind keeps it in the panel', () => {
    const page = (ext: string) => ({ plugin: 'p', id: ext, placement: 'preview', preview: { extensions: [ext] } }) as unknown as PluginView;
    const h = how({ pages: [page('.pptx')] });
    expect(pressFile('D:/周报.pptx', h)).toBe('preview');
    expect(h.open).not.toHaveBeenCalled();
  });

  it('when it cannot be opened (no program for it, the file gone), the notice bar says why', async () => {
    const h = how({ open: vi.fn(async () => '找不到文件：D:/周报.pptx') });
    pressFile('D:/周报.pptx', h);
    await vi.waitFor(() => expect(h.notice).toHaveBeenCalledWith('找不到文件：D:/周报.pptx'));
    const broken = how({ open: vi.fn(async () => Promise.reject(new Error('无法打开文件：没有关联的程序'))) });
    pressFile('D:/周报.pptx', broken);
    await vi.waitFor(() => expect(broken.notice).toHaveBeenCalledTimes(1));
    expect(broken.preview).not.toHaveBeenCalled();
  });
});
