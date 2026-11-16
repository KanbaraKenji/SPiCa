import { describe, expect, it } from 'vitest';
import { activate, activeTab, addressOf, closeTab, NO_TABS, openFile, openWeb, setOpen, tabName, updateActiveFile, updateWeb, type PaneTabs } from './pane-tabs';

const ids = (s: PaneTabs) => s.tabs.map((x) => x.id).join(' ');

describe('the right panel tabs', () => {
  it('a file opens a tab and the panel; the same file again is the same tab', () => {
    let s = openFile(NO_TABS, { sessionId: 'a', path: 'D:/x/report.pdf' });
    expect(s.open).toBe(true);
    expect(ids(s)).toBe('t1');
    s = openFile(s, { sessionId: 'a', path: 'D:/x/plan.docx' });
    s = openFile(s, { sessionId: 'a', path: 'D:/x/report.pdf' });
    expect(ids(s)).toBe('t1 t2');
    expect(s.active).toBe('t1');
  });

  it('the same path from another conversation, and every inline page, are tabs of their own', () => {
    let s = openFile(NO_TABS, { sessionId: 'a', path: 'notes.md' });
    s = openFile(s, { sessionId: 'b', path: 'notes.md' });
    const page = { kind: 'html', name: 'Chart', path: '', size: 1, text: 'x', truncated: false } as const;
    s = openFile(s, { sessionId: null, path: '', inline: page });
    s = openFile(s, { sessionId: null, path: '', inline: page });
    expect(s.tabs).toHaveLength(4);
  });

  it('new tabs go right after the one shown', () => {
    let s = openFile(NO_TABS, { sessionId: 'a', path: '1' });
    s = openFile(s, { sessionId: 'a', path: '2' });
    s = activate(s, 't1');
    s = openWeb(s, 'https://example.com/');
    expect(ids(s)).toBe('t1 t3 t2');
    expect(activeTab(s)).toMatchObject({ kind: 'web', url: 'https://example.com/' });
  });

  it('closing the tab shown shows its right-hand neighbour, else the left; the last one closes the panel', () => {
    let s = openFile(NO_TABS, { sessionId: 'a', path: '1' });
    s = openFile(s, { sessionId: 'a', path: '2' });
    s = openFile(s, { sessionId: 'a', path: '3' });
    s = activate(s, 't2');
    s = closeTab(s, 't2');
    expect(s.active).toBe('t3');
    s = closeTab(s, 't3');
    expect(s.active).toBe('t1');
    s = closeTab(s, 't1');
    expect(s).toMatchObject({ tabs: [], active: null, open: false });
  });

  it('closing a tab not shown keeps the one shown', () => {
    let s = openFile(NO_TABS, { sessionId: 'a', path: '1' });
    s = openFile(s, { sessionId: 'a', path: '2' });
    expect(closeTab(s, 't1').active).toBe('t2');
  });

  it('the panel closes and opens again with its tabs; it does not open with none', () => {
    let s = openFile(NO_TABS, { sessionId: 'a', path: '1' });
    s = setOpen(s, false);
    expect(s.tabs).toHaveLength(1);
    expect(setOpen(s, true).open).toBe(true);
    expect(setOpen(NO_TABS, true).open).toBe(false);
  });

  it('a page reports where it went and its title; the file shown takes another sheet', () => {
    let s = openWeb(NO_TABS, '');
    s = updateWeb(s, 't1', { url: 'https://example.com/a', title: 'A page' });
    expect(tabName(activeTab(s)!)).toBe('A page');
    s = openFile(s, { sessionId: 'a', path: 'D:/x/book.xlsx' });
    s = updateActiveFile(s, (r) => ({ ...r, sheet: 2 }));
    expect(activeTab(s)).toMatchObject({ req: { sheet: 2 } });
  });

  it('tab names', () => {
    expect(tabName({ id: 'x', kind: 'file', req: { sessionId: null, path: 'D:\\a\\b\\report.pdf' } })).toBe('report.pdf');
    expect(tabName({ id: 'x', kind: 'web', url: 'https://example.com/', title: '' })).toBe('example.com');
    expect(tabName({ id: 'x', kind: 'web', url: '', title: '' })).toBe('');
  });
});

describe('addressOf: what the address box opens', () => {
  it.each([
    ['https://example.com/a?b=1', 'https://example.com/a?b=1'],
    ['  http://localhost:5173  ', 'http://localhost:5173/'],
    ['example.com', 'https://example.com/'],
    ['docs.example.com/guide#x', 'https://docs.example.com/guide#x'],
    ['localhost:3000', 'https://localhost:3000/'],
    ['', ''],
    ['how to bake bread', ''],
    ['file:///C:/x.html', ''],
    ['javascript:alert(1)', ''],
    ['word', ''],
  ])('%s → %s', (typed, url) => expect(addressOf(typed)).toBe(url));
});
