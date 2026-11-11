import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeText, kindOf, PreviewFiles, readPreview, TEXT_LIMIT } from './preview';

describe('file preview', () => {
  it('knows what each file shows as', () => {
    expect(kindOf('a/报告.PDF')).toBe('pdf');
    expect(kindOf('a/图.png')).toBe('image');
    expect(kindOf('README.md')).toBe('markdown');
    expect(kindOf('page.htm')).toBe('html');
    expect(kindOf('main.py')).toBe('text');
    expect(kindOf('LICENSE')).toBe('text');
    expect(kindOf('表.xlsx')).toBe('unsupported');
  });

  it('reads Chinese text saved as UTF-8 or GB18030', () => {
    expect(decodeText(new TextEncoder().encode('样机评审'))).toBe('样机评审');
    // 「样机」 in GB18030
    expect(decodeText(new Uint8Array([0xd1, 0xf9, 0xbb, 0xfa]))).toBe('样机');
  });

  it('gives text (capped), URLs only for the files asked for, and words for the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-preview-'));
    writeFileSync(join(dir, 'a.md'), '# 标题');
    writeFileSync(join(dir, 'big.log'), 'x'.repeat(TEXT_LIMIT + 10));
    writeFileSync(join(dir, 'r.pdf'), '%PDF-1.4');
    writeFileSync(join(dir, 'q.xlsx'), 'PK');
    const files = new PreviewFiles();
    expect(await readPreview(join(dir, 'a.md'), files)).toMatchObject({ kind: 'markdown', text: '# 标题', truncated: false });
    const big = await readPreview(join(dir, 'big.log'), files);
    expect(big.kind === 'text' ? [big.text.length, big.truncated] : []).toEqual([TEXT_LIMIT, true]);
    const pdf = await readPreview(join(dir, 'r.pdf'), files);
    expect(pdf.kind).toBe('pdf');
    expect(pdf.kind === 'pdf' ? files.pathOf(pdf.url) : '').toBe(join(dir, 'r.pdf'));
    expect(files.pathOf('spica-file://f/not-a-token')).toBeUndefined();
    // A workbook that cannot be read (main/office-preview.ts reads the good ones).
    expect(await readPreview(join(dir, 'q.xlsx'), files)).toMatchObject({ kind: 'unsupported', message: '无法读取此文件。' });
    writeFileSync(join(dir, 'z.bin'), 'x');
    expect(await readPreview(join(dir, 'z.bin'), files)).toMatchObject({ kind: 'unsupported', message: '不支持预览此类文件。' });
    expect(await readPreview(join(dir, 'gone.txt'), files)).toMatchObject({ kind: 'missing' });
    expect(await readPreview(dir, files)).toMatchObject({ kind: 'unsupported', message: '不是文件' });
  });

  it('an SVG is a picture that also brings its source (for the panel’s 代码 view); other pictures do not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-preview-'));
    writeFileSync(join(dir, 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(dir, 'b.png'), 'PNG');
    const files = new PreviewFiles();
    expect(await readPreview(join(dir, 'a.svg'), files)).toMatchObject({ kind: 'image', text: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    expect(await readPreview(join(dir, 'b.png'), files)).not.toHaveProperty('text');
  });
});
