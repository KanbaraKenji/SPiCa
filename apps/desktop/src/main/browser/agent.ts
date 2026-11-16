// The built-in browser for agents (the core's browser_* tools reach these through the host methods 'browser.*').
// Each conversation works in its own tabs of the right panel (marked with it, shown to the person as they change);
// it cannot see or touch the person's tabs. Pages are read in an isolated world (browser/snapshot.ts). A screenshot
// is taken only of a page on screen: capturing a page out of sight stops the main process (tried).
import { asSnapshot, AGENT_WORLD, formatSnapshot, SNAPSHOT_SCRIPT, type PageSnapshot } from './snapshot';

/** A conversation's tab as the window reports it. */
export interface AgentTabInfo {
  tabId: string;
  /** The page's WebContents id; null while it is not loaded yet. */
  wcId: number | null;
  url: string;
  title: string;
}

/** What the window does for the agent (App.tsx answers). */
export interface AgentWindow {
  /** A new tab for this conversation, shown; resolves when its page exists. */
  open(sessionId: string, url: string): Promise<AgentTabInfo>;
  /** Shows the tab (the panel open, the tab in front); whether it is on screen now. */
  show(tabId: string): Promise<boolean>;
  /** This conversation's tabs, in order. */
  tabs(sessionId: string): Promise<AgentTabInfo[]>;
}

/** The parts of a page's WebContents used here. */
export interface AgentPage {
  isDestroyed(): boolean;
  isLoading(): boolean;
  getURL(): string;
  getTitle(): string;
  loadURL(url: string): Promise<void>;
  once(event: 'did-stop-loading', listener: () => void): unknown;
  removeListener(event: 'did-stop-loading', listener: () => void): unknown;
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(): Promise<{ toPNG(): Buffer; isEmpty(): boolean }>;
}

export interface BrowserAgentOptions {
  window: AgentWindow;
  page(wcId: number): AgentPage | undefined;
  /** How long to wait for a page to load (ms). */
  loadTimeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
}

export interface TabResult {
  tab: number;
  text: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Only web addresses: http and https. */
function webAddress(url: unknown): string {
  if (typeof url !== 'string') throw new Error('url must be a web address (http or https)');
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error(`not a web address: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`only http and https addresses can be opened: ${url}`);
  return u.href;
}

export class BrowserAgent {
  readonly #o: BrowserAgentOptions;
  /** The tab each conversation works in now. */
  readonly #current = new Map<string, string>();

  constructor(o: BrowserAgentOptions) {
    this.#o = o;
  }

  async #tabs(sessionId: string): Promise<AgentTabInfo[]> {
    return this.#o.window.tabs(sessionId);
  }

  /** The tab asked for (its number, 1-based) or the current one, with its page and number. */
  async #pick(sessionId: string, tab?: unknown): Promise<{ info: AgentTabInfo; number: number; page: AgentPage }> {
    const tabs = await this.#tabs(sessionId);
    if (!tabs.length) throw new Error('no tab open yet: open a page with browser_open first');
    let at: number;
    if (tab !== undefined && tab !== null) {
      const n = Number(tab);
      if (!Number.isInteger(n) || n < 1 || n > tabs.length) throw new Error(`no tab ${String(tab)} (this conversation has ${tabs.length})`);
      at = n - 1;
    } else {
      const cur = this.#current.get(sessionId);
      at = Math.max(0, cur ? tabs.findIndex((t) => t.tabId === cur) : tabs.length - 1);
      if (at < 0) at = tabs.length - 1;
    }
    const info = tabs[at]!;
    this.#current.set(sessionId, info.tabId);
    const page = info.wcId === null ? undefined : this.#o.page(info.wcId);
    if (!page || page.isDestroyed()) throw new Error(`tab ${at + 1} is not loaded (the person may have closed the panel); open the page again`);
    return { info, number: at + 1, page };
  }

  async #loaded(page: AgentPage): Promise<void> {
    if (!page.isLoading()) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        page.removeListener('did-stop-loading', done);
        resolve();
      }, this.#o.loadTimeoutMs ?? 15_000);
      page.once('did-stop-loading', done);
    });
  }

  async #snapshot(page: AgentPage): Promise<PageSnapshot> {
    const s = asSnapshot(await page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: SNAPSHOT_SCRIPT }]));
    if (!s) throw new Error('the page could not be read');
    return s;
  }

  /** Opens a web address: in this conversation's current tab, or a new one (the first time, or when asked). */
  async open(sessionId: string, args: { url?: unknown; new_tab?: unknown }): Promise<TabResult> {
    const url = webAddress(args.url);
    const tabs = await this.#tabs(sessionId);
    const cur = this.#current.get(sessionId);
    const reuse = args.new_tab !== true && tabs.some((t) => t.tabId === cur);
    if (reuse) {
      const { page, number } = await this.#pick(sessionId);
      await this.#o.window.show(this.#current.get(sessionId)!);
      await page.loadURL(url).catch(() => undefined); // a redirect or a stopped load still leaves a page to read
      await this.#loaded(page);
      return { tab: number, text: formatSnapshot(number, await this.#snapshot(page)) };
    }
    const info = await this.#o.window.open(sessionId, url);
    this.#current.set(sessionId, info.tabId);
    const { page, number } = await this.#pick(sessionId);
    await this.#loaded(page);
    return { tab: number, text: formatSnapshot(number, await this.#snapshot(page)) };
  }

  async read(sessionId: string, args: { tab?: unknown }): Promise<TabResult> {
    const { page, number } = await this.#pick(sessionId, args.tab);
    await this.#loaded(page);
    return { tab: number, text: formatSnapshot(number, await this.#snapshot(page)) };
  }

  /** A picture of the page as shown (it is brought on screen first; not taken when it cannot be). */
  async screenshot(sessionId: string, args: { tab?: unknown }): Promise<{ tab: number; url: string; title: string; png: string }> {
    const { info, page, number } = await this.#pick(sessionId, args.tab);
    const onScreen = await this.#o.window.show(info.tabId);
    await (this.#o.wait ?? sleep)(300);
    const state = await page.executeJavaScript('document.visibilityState').catch(() => 'hidden');
    if (!onScreen || state !== 'visible') throw new Error('the page is not on screen (the person is on another page of the app), so no picture can be taken now; read it with browser_read instead');
    const image = await page.capturePage();
    if (image.isEmpty()) throw new Error('the picture came out empty');
    return { tab: number, url: page.getURL(), title: page.getTitle(), png: image.toPNG().toString('base64') };
  }

  async scroll(sessionId: string, args: { direction?: unknown; tab?: unknown }): Promise<TabResult> {
    const { page, number } = await this.#pick(sessionId, args.tab);
    const dir = args.direction === 'up' ? -1 : args.direction === 'top' ? 0 : args.direction === 'bottom' ? 2 : 1;
    const where = (await page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [
      {
        code: `(() => { const d = ${dir}; if (d === 0) scrollTo(0, 0); else if (d === 2) scrollTo(0, document.documentElement.scrollHeight); else scrollBy(0, d * innerHeight * 0.8); return [Math.round(scrollY), Math.max(0, document.documentElement.scrollHeight - innerHeight)]; })()`,
      },
    ])) as [number, number] | undefined;
    const [y, max] = Array.isArray(where) ? where : [0, 0];
    return { tab: number, text: `Tab ${number}: scrolled to ${y} of ${max} pixels.` };
  }

  /** Waits for some text to appear on the page, or a number of seconds (at most 30). */
  async wait(sessionId: string, args: { text?: unknown; seconds?: unknown; tab?: unknown }): Promise<TabResult> {
    const { page, number } = await this.#pick(sessionId, args.tab);
    const limit = Math.min(30, Math.max(0.5, Number(args.seconds) || (typeof args.text === 'string' ? 10 : 2))) * 1000;
    const wait = this.#o.wait ?? sleep;
    if (typeof args.text !== 'string' || !args.text) {
      await wait(limit);
      return { tab: number, text: `Tab ${number}: waited ${limit / 1000} s.` };
    }
    const needle = JSON.stringify(args.text);
    for (let spent = 0; spent <= limit; spent += 500) {
      const found = await page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: `(document.body ? document.body.innerText : '').includes(${needle})` }]).catch(() => false);
      if (found === true) return { tab: number, text: `Tab ${number}: the text is on the page.` };
      await wait(500);
    }
    return { tab: number, text: `Tab ${number}: the text did not appear within ${limit / 1000} s.` };
  }

  /** This conversation's tabs; with switch_to, that one becomes the current tab. */
  async tabs(sessionId: string, args: { switch_to?: unknown }): Promise<{ text: string }> {
    if (args.switch_to !== undefined && args.switch_to !== null) {
      const { info } = await this.#pick(sessionId, args.switch_to);
      await this.#o.window.show(info.tabId);
    }
    const tabs = await this.#tabs(sessionId);
    if (!tabs.length) return { text: 'No tabs open.' };
    const cur = this.#current.get(sessionId);
    return { text: tabs.map((t, i) => `${t.tabId === cur ? '*' : ' '} ${i + 1}. ${t.title || '(no title)'} — ${t.url || 'about:blank'}`).join('\n') };
  }
}
