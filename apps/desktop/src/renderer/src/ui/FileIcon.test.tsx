// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { FileBadge, fileType } from './FileIcon';

afterEach(cleanup);

describe('file type marker', () => {
  it('knows the common office, image and archive types by extension, any case', () => {
    expect(fileType('2873302900_Inspection Record.pdf')?.label).toBe('PDF');
    expect(fileType('报价.XLSX')?.label).toBe('XLS');
    expect(fileType('需求说明.docx')?.label).toBe('DOC');
    expect(fileType('评审.pptx')?.label).toBe('PPT');
    expect(fileType('照片.jpeg')?.label).toBe('IMG');
    expect(fileType('notes.txt')).toBeUndefined();
    expect(fileType('README')).toBeUndefined();
  });

  it('a card shows the type on its colour, a plain file keeps the file icon', () => {
    const pdf = render(<FileBadge name="a.pdf" />).container.firstElementChild as HTMLElement;
    expect(pdf.textContent).toBe('PDF');
    expect(pdf.className).toContain('is-typed');
    cleanup();
    const txt = render(<FileBadge name="a.txt" />).container.firstElementChild as HTMLElement;
    expect(txt.querySelector('svg')).toBeTruthy();
    expect(txt.className).not.toContain('is-typed');
  });
});
