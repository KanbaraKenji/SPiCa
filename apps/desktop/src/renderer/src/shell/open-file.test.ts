import { describe, expect, it, vi } from 'vitest';
import type { PluginView } from '../../../shared/plugin-view';
import { pressFile, type FilePress } from './open-file';

const how = (over: Partial<FilePress> = {}): FilePress => ({
  pages: [],
  open: vi.fn(async () => null),
  picture: vi.fn(async (path: string) => ({ url: `spica-file://f/x?v=1`, name: path.split('/').pop()! })),
  showPicture: vi.fn(),
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

  it('a picture shows big over the window, not in the preview; an SVG too', async () => {
    for (const name of ['D:/图/横幅.png', 'D:/图/照片.JPG', 'D:/图/流程.svg', 'D:/图/a.webp']) {
      const h = how();
      expect(pressFile(name, h)).toBe('picture');
      await vi.waitFor(() => expect(h.showPicture).toHaveBeenCalledWith({ url: 'spica-file://f/x?v=1', name: name.split('/').pop() }));
      expect(h.preview).not.toHaveBeenCalled();
      expect(h.open).not.toHaveBeenCalled();
    }
  });

  it('a picture that cannot be read says why in the notice bar, and nothing opens', async () => {
    const h = how({ picture: vi.fn(async () => '找不到文件，可能已被移动或删除。') });
    pressFile('D:/图/没了.png', h);
    await vi.waitFor(() => expect(h.notice).toHaveBeenCalledWith('找不到文件，可能已被移动或删除。'));
    expect(h.showPicture).not.toHaveBeenCalled();
    expect(h.preview).not.toHaveBeenCalled();
  });

  it('other files still open in the preview, the ones it cannot show too (they say so there)', () => {
    for (const name of ['D:/a.docx', 'D:/a.xlsx', 'D:/a.csv', 'D:/a.zip', 'D:/a.mp4', 'D:/a.avif', 'D:/a.dwg', 'D:/LICENSE']) {
      const h = how();
      expect(pressFile(name, h)).toBe('preview');
      expect(h.preview).toHaveBeenCalledWith(name);
      expect(h.open).not.toHaveBeenCalled();
    }
  });

  it('a plugin preview page for the kind keeps it in the panel', () => {
    const page = (ext: string) => ({ plugin: 'p', id: ext, placement: 'preview', preview: { extensions: [ext] } }) as unknown as PluginView;
    for (const [name, ext] of [['D:/周报.pptx', '.pptx'], ['D:/横幅.png', '.png']] as const) {
      const h = how({ pages: [page(ext)] });
      expect(pressFile(name, h)).toBe('preview');
      expect(h.open).not.toHaveBeenCalled();
      expect(h.picture).not.toHaveBeenCalled();
    }
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
