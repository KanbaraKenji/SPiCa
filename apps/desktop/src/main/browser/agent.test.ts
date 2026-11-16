import { describe, expect, it } from 'vitest';
import { BrowserAgent, type AgentPage, type AgentTabInfo } from './agent';
import { asSnapshot, formatSnapshot, type PageSnapshot } from './snapshot';

const snap = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({
  url: 'https://example.com/a',
  title: 'A page',
  text: 'Hello',
  truncated: false,
  elements: [
    { ref: 1, role: 'link', name: 'Docs', href: 'https://example.com/docs' },
    { ref: 2, role: 'textbox', name: 'Email', type: 'email', value: 'a@b.c' },
    { ref: 3, role: 'textbox', name: 'Password', type: 'password' },
  ],
  more: 0,
  ...over,
});

describe('formatSnapshot', () => {
  it('tab, address, text, numbered elements', () => {
    expect(formatSnapshot(2, snap())).toBe(
      ['Tab 2: A page', 'Address: https://example.com/a', '', 'Hello', '', 'Elements (use the number with the browser tools):', '[1] link "Docs" → https://example.com/docs', '[2] textbox "Email" email value "a@b.c"', '[3] textbox "Password" password'].join('\n'),
    );
  });
  it('cut text and more elements are said', () => {
    const t = formatSnapshot(1, snap({ truncated: true, more: 5, elements: [] }));
    expect(t).toContain('(text cut at 12000 characters)');
    expect(t).toContain('No elements to act on.');
    expect(t).toContain('(5 more not listed)');
  });
});

describe('asSnapshot', () => {
  it('keeps the expected shape, drops the rest', () => {
    expect(asSnapshot(null)).toBeNull();
    expect(asSnapshot({ url: 1 })).toBeNull();
    const s = asSnapshot({ url: 'u', title: 't', text: 'x', elements: [{ ref: 1, role: 'button', name: 'Go', extra: 'x' }, { ref: 'no' }, null], more: 'z' });
    expect(s).toEqual({ url: 'u', title: 't', text: 'x', truncated: false, elements: [{ ref: 1, role: 'button', name: 'Go' }], more: 0 });
  });
});

function fakePage(state: { url: string; loading?: boolean; visible?: boolean; snapshot?: unknown }) {
  const loaded: string[] = [];
  const page: AgentPage = {
    isDestroyed: () => false,
    isLoading: () => state.loading === true,
    getURL: () => state.url,
    getTitle: () => 'T',
    loadURL: async (u) => {
      loaded.push(u);
      state.url = u;
    },
    once: () => undefined,
    removeListener: () => undefined,
    executeJavaScriptInIsolatedWorld: async () => state.snapshot ?? snap({ url: state.url }),
    executeJavaScript: async () => (state.visible === false ? 'hidden' : 'visible'),
    capturePage: async () => ({ toPNG: () => Buffer.from('png'), isEmpty: () => false }),
  };
  return { page, loaded };
}

function setup() {
  const tabs: AgentTabInfo[] = [];
  const pages = new Map<number, ReturnType<typeof fakePage>>();
  const shown: string[] = [];
  let onScreen = true;
  const agent = new BrowserAgent({
    window: {
      open: async (sessionId, url) => {
        const wcId = 100 + tabs.length;
        const t = { tabId: `t${tabs.length + 1}`, wcId, url, title: '', session: sessionId } as AgentTabInfo & { session: string };
        tabs.push(t);
        pages.set(wcId, fakePage({ url }));
        return t;
      },
      show: async (tabId) => {
        shown.push(tabId);
        return onScreen;
      },
      tabs: async (sessionId) => tabs.filter((t) => (t as AgentTabInfo & { session: string }).session === sessionId),
    },
    page: (id) => pages.get(id)?.page,
    wait: async () => undefined,
  });
  return { agent, tabs, pages, shown, offScreen: () => (onScreen = false) };
}

describe('BrowserAgent', () => {
  it('open: a new tab the first time, then the same tab; new_tab opens another', async () => {
    const s = setup();
    const first = await s.agent.open('s1', { url: 'https://example.com/a' });
    expect(first.tab).toBe(1);
    expect(first.text).toContain('Address: https://example.com/a');
    await s.agent.open('s1', { url: 'https://example.com/b' });
    expect(s.tabs).toHaveLength(1);
    expect(s.pages.get(100)!.loaded).toEqual(['https://example.com/b']);
    const third = await s.agent.open('s1', { url: 'https://example.com/c', new_tab: true });
    expect(third.tab).toBe(2);
  });

  it('only web addresses', async () => {
    const s = setup();
    for (const url of ['file:///C:/x.html', 'javascript:alert(1)', 'spica-page://t/x.html', 'not a url', 42]) await expect(s.agent.open('s1', { url })).rejects.toThrow();
  });

  it("a conversation sees only its own tabs", async () => {
    const s = setup();
    await s.agent.open('s1', { url: 'https://example.com/a' });
    await expect(s.agent.read('s2', {})).rejects.toThrow(/no tab open yet/);
    expect((await s.agent.tabs('s2', {})).text).toBe('No tabs open.');
    expect((await s.agent.tabs('s1', {})).text).toBe('* 1. (no title) — https://example.com/a');
  });

  it('read a tab by number; a wrong number is said', async () => {
    const s = setup();
    await s.agent.open('s1', { url: 'https://example.com/a' });
    await s.agent.open('s1', { url: 'https://example.com/b', new_tab: true });
    expect((await s.agent.read('s1', { tab: 1 })).text).toContain('example.com/a');
    await expect(s.agent.read('s1', { tab: 3 })).rejects.toThrow(/no tab 3/);
  });

  it('screenshot: shows the tab first; not taken when it is not on screen', async () => {
    const s = setup();
    await s.agent.open('s1', { url: 'https://example.com/a' });
    const shot = await s.agent.screenshot('s1', {});
    expect(shot.png).toBe(Buffer.from('png').toString('base64'));
    expect(s.shown).toContain('t1');
    s.offScreen();
    await expect(s.agent.screenshot('s1', {})).rejects.toThrow(/not on screen/);
  });

  it('a page that cannot be read is said', async () => {
    const s = setup();
    await s.agent.open('s1', { url: 'https://example.com/a' });
    s.pages.get(100)!.page.executeJavaScriptInIsolatedWorld = async () => 'nonsense';
    await expect(s.agent.read('s1', {})).rejects.toThrow(/could not be read/);
  });
});
