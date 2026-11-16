// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LinkRouter, linkAt, placeFor, type LinkPlace } from './links';
import type { LinkOpen } from '../../../shared/settings';

afterEach(cleanup);

describe('placeFor', () => {
  const plain = { ctrlKey: false, metaKey: false, shiftKey: false };
  it('the setting, or the question', () => {
    expect(placeFor('panel', plain)).toBe('panel');
    expect(placeFor('system', plain)).toBe('system');
    expect(placeFor('ask', plain)).toBeNull();
  });
  it('Ctrl, ⌘ or Shift: the system browser whatever the setting', () => {
    expect(placeFor('panel', { ...plain, ctrlKey: true })).toBe('system');
    expect(placeFor('ask', { ...plain, metaKey: true })).toBe('system');
    expect(placeFor('ask', { ...plain, shiftKey: true })).toBe('system');
  });
});

describe('linkAt', () => {
  it('web addresses only, from anything inside the link', () => {
    document.body.innerHTML = '<a id="w" href="https://example.com/a"><span id="in">x</span></a><a id="h" href="history:12">y</a><a id="m" href="mailto:a@b.c">z</a>';
    expect(linkAt(document.getElementById('in'))).toBe('https://example.com/a');
    expect(linkAt(document.getElementById('h'))).toBeNull();
    expect(linkAt(document.getElementById('m'))).toBeNull();
    expect(linkAt(document.body)).toBeNull();
  });
});

function setup(setting: LinkOpen) {
  const opened: [string, LinkPlace][] = [];
  const kept: LinkPlace[] = [];
  render(
    <>
      <a href="https://example.com/doc" target="_blank" rel="noreferrer">
        doc
      </a>
      <LinkRouter setting={setting} open={(url, place) => opened.push([url, place])} remember={(p) => kept.push(p)} />
    </>,
  );
  return { opened, kept, link: screen.getByText('doc') };
}

describe('LinkRouter', () => {
  it('a setting: opens there at once, no question', () => {
    const s = setup('panel');
    expect(fireEvent.click(s.link)).toBe(false); // the window's own new-window is prevented
    expect(s.opened).toEqual([['https://example.com/doc', 'panel']]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('每次询问: the question, 内置浏览器 first; 确定 opens there; not kept unless ticked', () => {
    const s = setup('ask');
    fireEvent.click(s.link);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('在哪里打开网址？');
    expect(dialog.textContent).toContain('https://example.com/doc');
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    fireEvent.click(screen.getByText('确定'));
    expect(s.opened).toEqual([['https://example.com/doc', 'panel']]);
    expect(s.kept).toEqual([]);
  });

  it('记住我的选择 ticked: the answer is kept as the setting', () => {
    const s = setup('ask');
    fireEvent.click(s.link);
    fireEvent.click(screen.getByLabelText('系统浏览器'));
    fireEvent.click(screen.getByLabelText('记住我的选择'));
    fireEvent.click(screen.getByText('确定'));
    expect(s.opened).toEqual([['https://example.com/doc', 'system']]);
    expect(s.kept).toEqual(['system']);
  });

  it('closed without an answer: nothing opens', () => {
    const s = setup('ask');
    fireEvent.click(s.link);
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(s.opened).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a right click offers both, whatever the setting', () => {
    const s = setup('panel');
    fireEvent.contextMenu(s.link);
    fireEvent.click(screen.getByText('用系统浏览器打开'));
    expect(s.opened).toEqual([['https://example.com/doc', 'system']]);
  });
});
