// The built-in browser for agents (the core's browser_* tools reach these through the host methods 'browser.*').
// Each conversation works in its own tabs of the right panel (marked with it, shown to the person as they change);
// it cannot see or touch the person's tabs. Pages are read in an isolated world (browser/snapshot.ts). A screenshot
// is taken only of a page on screen: capturing a page out of sight stops the main process (tried).
import { asSnapshot, AGENT_WORLD, formatSnapshot, SNAPSHOT_SCRIPT, type PageSnapshot } from './snapshot';
import { asFacts, fingerprint, inspectScript, judge, KEYS, type ActionTool, type ElementFacts } from './actions';

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
  /** A DevTools protocol command (input that works without the window having focus); see page-input.ts. */
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface BrowserAgentOptions {
  window: AgentWindow;
  page(wcId: number): AgentPage | undefined;
  /** How long to wait for a page to load (ms). */
  loadTimeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
  /** For a moment after an unconfirmed click or key: a form sent by the page is stopped (browser/session.ts). */
  guardSubmit?: (wcId: number, ms: number) => void;
  /** The person took over a tab (they pressed in its page), or gave it back. */
  onTakeOver?: (tabId: string, taken: boolean) => void;
}

export interface TabResult {
  tab: number;
  text: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The element that has the focus (a key goes there), described as inspectScript describes one. */
const FOCUSED_SCRIPT = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { found: false, page: location.href };
  const form = el.form || el.closest('form');
  const tag = el.tagName.toLowerCase();
  return { found: true, tag, type: String(el.getAttribute('type') || '').toLowerCase(), role: el.getAttribute('role') || '', name: String(el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').slice(0, 80),
    ...(form ? { form: { action: form.action || location.href, method: (form.getAttribute('method') || 'get').toLowerCase() } } : {}),
    autocomplete: String(el.getAttribute('autocomplete') || ''), fieldName: String((el.getAttribute('name') || '') + ' ' + (el.id || '')), editable: true, page: location.href, x: 0, y: 0 };
})()`;

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

  // ---- acting on a page: click, type, press (browser/actions.ts judges each first) ----

  /** Pages the person took over (pressed in): the agent leaves them until they are given back. By WebContents id. */
  readonly #taken = new Set<number>();
  /** WebContents id → tab, as last seen. */
  readonly #tabOf = new Map<number, string>();

  /** The person pressed in a page while the agent was not acting there: if it is an agent's tab, it is theirs now. */
  humanInput(wcId: number): void {
    const tabId = this.#tabOf.get(wcId);
    if (!tabId || this.#taken.has(wcId)) return;
    this.#taken.add(wcId);
    this.#o.onTakeOver?.(tabId, true);
  }

  /** 交还: the agent may act in this tab again. */
  giveBack(tabId: string): void {
    for (const [wcId, t] of this.#tabOf) {
      if (t !== tabId || !this.#taken.delete(wcId)) continue;
      this.#o.onTakeOver?.(tabId, false);
    }
  }

  isTaken(tabId: string): boolean {
    for (const [wcId, t] of this.#tabOf) if (t === tabId && this.#taken.has(wcId)) return true;
    return false;
  }

  async #actPage(sessionId: string, tab: unknown): Promise<{ info: AgentTabInfo; number: number; page: AgentPage }> {
    const picked = await this.#pick(sessionId, tab);
    if (picked.info.wcId !== null) {
      this.#tabOf.set(picked.info.wcId, picked.info.tabId);
      if (this.#taken.has(picked.info.wcId)) throw new Error(`the person has taken over tab ${picked.number} (they are using it); wait until they give it back, or ask them`);
    }
    return picked;
  }

  async #facts(page: AgentPage, tool: ActionTool, ref: unknown): Promise<ElementFacts | null> {
    if (tool === 'browser_press') {
      const v = await page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: FOCUSED_SCRIPT }]).catch(() => null);
      return asFacts(v);
    }
    const n = Number(ref);
    if (!Number.isInteger(n) || n < 1) throw new Error('ref must be an element number from browser_read');
    return asFacts(await page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: inspectScript(n) }]).catch(() => null));
  }

  /**
   * Before the call (a hook in the core): whether to do it, ask first (with what to say and what the element is now),
   * or leave it to the person. Nothing is done here.
   */
  async inspect(sessionId: string, args: { tool?: unknown; ref?: unknown; tab?: unknown; key?: unknown; submit?: unknown; callId?: unknown }): Promise<{ verdict: ReturnType<typeof judge> }> {
    const tool = String(args.tool) as ActionTool;
    if (tool !== 'browser_click' && tool !== 'browser_type' && tool !== 'browser_press') return { verdict: { action: 'allow' } };
    let page: AgentPage;
    try {
      ({ page } = await this.#actPage(sessionId, args.tab));
    } catch {
      return { verdict: { action: 'allow' } }; // the tool itself says what is wrong
    }
    const f = await this.#facts(page, tool, args.ref).catch(() => null);
    const verdict = judge(tool, f, args);
    // what the person is asked about, kept for the call itself (by its id): changed by then, nothing is done
    if (verdict.action === 'confirm' && f?.found && typeof args.callId === 'string') this.#asked.set(args.callId, fingerprint(f));
    return { verdict };
  }

  /** What each confirmed action was asked about, by call id (taken when the call runs). */
  readonly #asked = new Map<string, string>();

  /** The fingerprint asked about for this call, if it was asked about (once). */
  #expectFor(args: { callId?: unknown; expect?: unknown }): string | undefined {
    if (typeof args.expect === 'string' && args.expect) return args.expect;
    if (typeof args.callId !== 'string') return undefined;
    const f = this.#asked.get(args.callId);
    this.#asked.delete(args.callId);
    return f;
  }

  /** After an action: let the page react, then read it. */
  async #after(page: AgentPage, number: number, note: string): Promise<TabResult> {
    await (this.#o.wait ?? sleep)(500);
    await this.#loaded(page);
    return { tab: number, text: `${note}\n\n${formatSnapshot(number, await this.#snapshot(page))}` };
  }

  /** Same element as when it was confirmed (or nothing was asked): else nothing is done. */
  #still(f: ElementFacts | null, expect: unknown): ElementFacts {
    if (!f || !f.found) throw new Error('that element is not on the page any more; read the page again (browser_read)');
    if (typeof expect === 'string' && expect && fingerprint(f) !== expect) throw new Error('the page changed after you asked, so nothing was done; read it again and ask again');
    return f;
  }

  async #mouse(page: AgentPage, x: number, y: number): Promise<void> {
    for (const type of ['mousePressed', 'mouseReleased']) await page.cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }

  async click(sessionId: string, args: { ref?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    const expect = this.#expectFor(args);
    const { info, page, number } = await this.#actPage(sessionId, args.tab);
    const f = this.#still(await this.#facts(page, 'browser_click', args.ref), expect);
    if (!expect && info.wcId !== null) this.#o.guardSubmit?.(info.wcId, 3000);
    await this.#mouse(page, f.x, f.y);
    return this.#after(page, number, `Clicked [${String(args.ref)}] ${f.name ? `"${f.name}"` : f.tag}.`);
  }

  async type(sessionId: string, args: { ref?: unknown; text?: unknown; submit?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    const expect = this.#expectFor(args);
    const { info, page, number } = await this.#actPage(sessionId, args.tab);
    const f = this.#still(await this.#facts(page, 'browser_type', args.ref), expect);
    if (judge('browser_type', f).action === 'deny') throw new Error('that is a password, card number or code field: the person types it themselves');
    if (!f.editable) throw new Error(`[${String(args.ref)}] is not a text box`);
    if (typeof args.text !== 'string') throw new Error('text is required');
    // into the field (clicked, so it has the focus), what was there replaced
    await this.#mouse(page, f.x, f.y);
    await page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: `(() => { const el = document.activeElement; if (el && 'select' in el) el.select(); else document.execCommand('selectAll'); })()` }]).catch(() => undefined);
    await page.cdp('Input.insertText', { text: args.text });
    if (args.submit === true) {
      if (!expect && info.wcId !== null) this.#o.guardSubmit?.(info.wcId, 3000);
      await this.#key(page, 'enter');
    }
    return this.#after(page, number, `Typed into [${String(args.ref)}]${args.submit === true ? ' and pressed Enter' : ''}.`);
  }

  async #key(page: AgentPage, name: string): Promise<void> {
    const k = KEYS[name.toLowerCase()];
    if (!k) throw new Error(`unknown key "${name}" (known: ${Object.keys(KEYS).join(', ')})`);
    const text = k.key === 'Enter' ? '\r' : k.key === ' ' ? ' ' : undefined;
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, ...(text ? { text } : {}) });
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
  }

  async press(sessionId: string, args: { key?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    const expect = this.#expectFor(args);
    const { info, page, number } = await this.#actPage(sessionId, args.tab);
    if (expect) this.#still(await this.#facts(page, 'browser_press', undefined), expect);
    else if (info.wcId !== null) this.#o.guardSubmit?.(info.wcId, 3000);
    await this.#key(page, String(args.key ?? ''));
    return this.#after(page, number, `Pressed ${String(args.key)}.`);
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
