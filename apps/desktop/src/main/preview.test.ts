import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unreadable } from './office-preview';
import { decodeText, kindOf, PreviewFiles, readPreview, TEXT_LIMIT } from './preview';

describe('file preview', () => {
  it('knows what each file shows as', () => {
    expect(kindOf('a/报告.PDF')).toBe('pdf');
    expect(kindOf('a/图.png')).toBe('image');
    expect(kindOf('README.md')).toBe('markdown');
    expect(kindOf('page.htm')).toBe('html');
    expect(kindOf('main.py')).toBe('text');
    expect(kindOf('会议录音.MP3')).toBe('audio');
    expect(kindOf('a.wav')).toBe('audio');
    expect(kindOf('演示.mp4')).toBe('video');
    expect(kindOf('clip.webm')).toBe('video');
    expect(kindOf('clip.mkv')).toBe('unsupported');
    expect(kindOf('LICENSE')).toBe('text');
    expect(kindOf('表.xlsx')).toBe('unsupported');
  });

  it('reads Chinese text saved as UTF-8 or GB18030', () => {
    expect(decodeText(new TextEncoder().encode('样机评审'))).toBe('样机评审');
    // 「样机」 in GB18030
    expect(decodeText(new Uint8Array([0xd1, 0xf9, 0xbb, 0xfa]))).toBe('样机');
  });

  it('reads UTF-16 text, with its byte order mark or without (PowerShell 5.1 writes it)', () => {
    const le = (s: string) => Array.from(Buffer.from(s, 'utf16le'));
    expect(decodeText(new Uint8Array([0xff, 0xfe, ...le('样机 ok\r\n')]))).toBe('样机 ok\r\n');
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0x68, 0x37, 0x67, 0x3a]))).toBe('样机');
    expect(decodeText(new Uint8Array(le('Name  Size\r\nreport.docx  12\r\n')))).toBe('Name  Size\r\nreport.docx  12\r\n');
    // UTF-8 with a few zero bytes is not taken for UTF-16.
    expect(decodeText(new TextEncoder().encode('a\u0000bcdefgh'))).toBe('a\u0000bcdefgh');
  });

  it('a file it may not read says so, not that it is gone', () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    expect(unreadable(err('ENOENT'))).toEqual({ kind: 'missing', message: '找不到文件，可能已被移动或删除。' });
    expect(unreadable(err('EPERM'))).toEqual({ kind: 'unsupported', message: '没有权限读取此文件。' });
    expect(unreadable(err('EACCES')).message).toBe('没有权限读取此文件。');
    expect(unreadable(err('EBUSY')).message).toBe('无法读取此文件。');
  });

  it.runIf(process.platform === 'win32')('a system file Windows keeps to itself is not called missing, and gets no viewer', async () => {
    // Every Windows has it; nobody may read it while Windows runs (refused, or in use for an administrator).
    const info = await readPreview('C:/Windows/System32/config/SAM', new PreviewFiles());
    expect(info.kind).toBe('unsupported');
    expect(['没有权限读取此文件。', '无法读取此文件。']).toContain('message' in info ? info.message : '');
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
    // Rewritten, the same file is a new URL (the viewer does not show the one it kept).
    utimesSync(join(dir, 'r.pdf'), new Date(2026, 0, 1), new Date(2026, 0, 1));
    const again = await readPreview(join(dir, 'r.pdf'), files);
    expect(again.kind === 'pdf' ? [again.url === (pdf.kind === 'pdf' ? pdf.url : ''), files.pathOf(again.url)] : []).toEqual([false, join(dir, 'r.pdf')]);
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

describe('sound and video', () => {
  it('played in the panel through spica-file, the file time in the address', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spica-media-'));
    const file = join(dir, '会议录音.mp3');
    writeFileSync(file, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    const files = new PreviewFiles();
    const info = await readPreview(file, files);
    expect(info).toMatchObject({ kind: 'audio', name: '会议录音.mp3', size: 4 });
    expect(info.kind === 'audio' && info.url).toMatch(/^spica-file:\/\/.+\?v=\d+$/);
    const video = await readPreview(join(dir, 'missing.mp4'), files);
    expect(video.kind).toBe('missing');
  });
});