// The built-in browser for agents (the core's browser_* tools reach these through the host methods 'browser.*').
// Each conversation works in its own tabs of the right panel (marked with it, shown to the person as they change);
// it cannot see or touch the person's tabs. Pages are read in an isolated world (browser/snapshot.ts), the frames in
// them (iframes, also of other sites) through the DevTools protocol (browser/frames.ts). A screenshot is taken only
// of a page on screen: capturing a page out of sight stops the main process (tried).
import { asSnapshot, AGENT_WORLD, elementLine, findScript, FRAME_TEXT_LIMIT, formatSnapshot, SNAPSHOT_SCRIPT, type FrameSnapshot, type PageElement, type PageSnapshot } from './snapshot';
import { asFacts, fingerprint, inspectScript, judge, KEYS, ACTION_TOOLS, type ActionTool, type ElementFacts } from './actions';
import { pageFrames, type FrameInfo } from './frames';
import { pageLog, type RequestEntry } from './page-log';

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

/** What a page's protocol sessions report: an event, and the session it came in (undefined: the page's own). */
export type CdpListener = (method: string, params: Record<string, unknown>, sessionId?: string) => void;

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
  cdp(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  /** Told of the protocol's events. */
  onCdp?(listener: CdpListener): () => void;
  /** Run each time the protocol is attached (to turn on what is collected). */
  onAttached?(hook: () => Promise<void>): () => void;
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
  if (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) return { found: false, inFrame: true, page: location.href };
  if (!el || el === document.body) return { found: false, page: location.href, focused: document.hasFocus() };
  const form = el.form || el.closest('form');
  const tag = el.tagName.toLowerCase();
  return { found: true, focused: document.hasFocus(), tag, type: String(el.getAttribute('type') || '').toLowerCase(), role: el.getAttribute('role') || '', name: String(el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').slice(0, 80),
    ...(form ? { form: { action: form.action || location.href, method: (form.getAttribute('method') || 'get').toLowerCase() } } : {}),
    autocomplete: String(el.getAttribute('autocomplete') || ''), fieldName: String((el.getAttribute('name') || '') + ' ' + (el.id || '')), editable: true, page: location.href, x: 0, y: 0 };
})()`;

/** Selects everything in the focused field (typing then replaces it). */
const SELECT_ALL = `(() => { const el = document.activeElement; if (el && 'select' in el) el.select(); else document.execCommand('selectAll'); })()`;

/** Picks options of a drop-down (by their value or their words); the page is told as if the person had. */
function selectScript(ref: number, doc: string | undefined, values: string[]): string {
  return `(() => {
    if (${JSON.stringify(doc ?? '')} && window.__spicaDoc !== ${JSON.stringify(doc ?? '')}) return { found: false };
    const el = (window.__spicaRefs || [])[${Math.floor(ref)} - 1];
    if (!el || !el.isConnected) return { found: false };
    if (el.tagName !== 'SELECT') return { found: true, select: false };
    const want = ${JSON.stringify(values)};
    const opts = [...el.options];
    const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const pick = (w) => opts.find((o) => o.value === w) || opts.find((o) => o.text.trim() === w.trim()) || opts.find((o) => norm(o.text) === norm(w)) || opts.find((o) => norm(o.text).includes(norm(w)));
    const chosen = want.map(pick);
    if (chosen.some((o) => !o)) return { found: true, select: true, missing: want.filter((w, i) => !chosen[i]), options: opts.slice(0, 50).map((o) => o.text.trim()) };
    if (el.multiple) for (const o of opts) o.selected = chosen.includes(o);
    else el.value = chosen[0].value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true, select: true, chosen: chosen.map((o) => o.text.trim()) };
  })()`;
}

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

/** Where a numbered element is: in the page (no frame) or a frame, with its number there and the document it was in. */
interface RefPlace {
  frameId?: string;
  doc?: string;
  local: number;
}

/**
 * The numbers the agent sees for one page. Each frame (and the page) numbers its own elements; here they get one
 * number per page, kept while the element stays (snapshot.ts), started again when the page itself is a new document.
 */
class RefBook {
  doc: string | undefined;
  next = 1;
  readonly byKey = new Map<string, number>();
  readonly byRef = new Map<number, RefPlace>();

  number(place: RefPlace): number {
    const key = `${place.frameId ?? ''}@${place.doc ?? ''}#${place.local}`;
    let n = this.byKey.get(key);
    if (n === undefined) {
      // the page's own elements keep their own numbers when they can (nothing else had it)
      n = !place.frameId && !this.byRef.has(place.local) && place.local >= this.next ? place.local : this.next;
      this.next = Math.max(this.next, n + 1);
      this.byKey.set(key, n);
      this.byRef.set(n, place);
    }
    return n;
  }

  reset(doc: string | undefined): void {
    this.doc = doc;
    this.next = 1;
    this.byKey.clear();
    this.byRef.clear();
  }
}

/** Most characters of what a script returns. */
const SCRIPT_RESULT_LIMIT = 20_000;
/** How long a script may run (ms). */
const SCRIPT_TIMEOUT_MS = 30_000;

function lineOf(level: string, text: string, source?: string): string {
  return `[${level}] ${text}${source ? `  (${source})` : ''}`;
}

export class BrowserAgent {
  readonly #o: BrowserAgentOptions;
  /** The tab each conversation works in now. */
  readonly #current = new Map<string, string>();
  readonly #books = new WeakMap<AgentPage, RefBook>();

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

  #book(page: AgentPage): RefBook {
    let b = this.#books.get(page);
    if (!b) this.#books.set(page, (b = new RefBook()));
    return b;
  }

  /** The page's elements numbered for the agent (one numbering for the page and its frames). */
  #numbered(page: AgentPage, doc: string | undefined, frameId: string | undefined, elements: PageElement[]): PageElement[] {
    const book = this.#book(page);
    if (!frameId && doc !== undefined && book.doc !== doc) book.reset(doc);
    return elements.map((e) => ({ ...e, ref: book.number({ ...(frameId ? { frameId } : {}), ...(doc !== undefined ? { doc } : {}), local: e.ref }) }));
  }

  /** The frames that show, each with where it sits. */
  async #frames(page: AgentPage): Promise<{ frames: FrameInfo[]; shown: FrameInfo[] }> {
    const pf = pageFrames(page);
    const frames = await pf.list().catch((): FrameInfo[] => []);
    const shown: FrameInfo[] = [];
    for (const f of frames) if ((await pf.offset(f, frames).catch(() => ({ shown: false }))).shown) shown.push(f);
    return { frames, shown };
  }

  async #snapshot(page: AgentPage): Promise<PageSnapshot> {
    const s = asSnapshot(await page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: SNAPSHOT_SCRIPT }]));
    if (!s) throw new Error('the page could not be read');
    s.elements = this.#numbered(page, s.doc, undefined, s.elements);
    const pf = pageFrames(page);
    const frames: FrameSnapshot[] = [];
    for (const f of (await this.#frames(page)).shown) {
      const v = asSnapshot(await pf.evaluate(f, SNAPSHOT_SCRIPT).catch(() => null));
      if (!v || (!v.text.trim() && !v.elements.length)) continue;
      const text = v.text.slice(0, FRAME_TEXT_LIMIT);
      frames.push({ url: v.url, text, truncated: v.truncated || v.text.length > FRAME_TEXT_LIMIT, elements: this.#numbered(page, v.doc, f.frameId, v.elements), more: v.more });
    }
    if (frames.length) s.frames = frames;
    return s;
  }

  /** From this call on, what the page writes to its console and the requests it makes are kept (browser_console, browser_network). */
  async #collect(page: AgentPage): Promise<void> {
    pageFrames(page);
    await pageLog(page).start();
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
      await this.#collect(page);
      await page.loadURL(url).catch(() => undefined); // a redirect or a stopped load still leaves a page to read
      await this.#loaded(page);
      return { tab: number, text: formatSnapshot(number, await this.#snapshot(page)) };
    }
    // a blank tab first: the console and the requests are collected from the page's first request on
    const info = await this.#o.window.open(sessionId, 'about:blank');
    this.#current.set(sessionId, info.tabId);
    const { page, number } = await this.#pick(sessionId);
    await this.#collect(page);
    await page.loadURL(url).catch(() => undefined);
    await this.#loaded(page);
    return { tab: number, text: formatSnapshot(number, await this.#snapshot(page)) };
  }

  async read(sessionId: string, args: { tab?: unknown }): Promise<TabResult> {
    const { page, number } = await this.#pick(sessionId, args.tab);
    await this.#loaded(page);
    return { tab: number, text: formatSnapshot(number, await this.#snapshot(page)) };
  }

  /** Elements whose words, role, value or address hold the query (any case), in the page and its frames. */
  async find(sessionId: string, args: { query?: unknown; tab?: unknown }): Promise<TabResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('query is required (words on or about the element)');
    const { page, number } = await this.#pick(sessionId, args.tab);
    await this.#loaded(page);
    const found: PageElement[] = [];
    const main = (await page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: findScript(query) }]).catch(() => null)) as { doc?: string; elements?: PageElement[] } | null;
    const pageSnap = asSnapshot({ url: '', text: '', elements: main?.elements ?? [] });
    // numbers here are the page's own; a new document since the last read starts the numbering again
    found.push(...this.#numbered(page, main?.doc, undefined, pageSnap?.elements ?? []));
    const pf = pageFrames(page);
    for (const f of (await this.#frames(page)).shown) {
      if (found.length >= 20) break;
      const v = (await pf.evaluate(f, findScript(query)).catch(() => null)) as { doc?: string; elements?: PageElement[] } | null;
      const els = asSnapshot({ url: '', text: '', elements: v?.elements ?? [] })?.elements ?? [];
      found.push(...this.#numbered(page, v?.doc, f.frameId, els).map((e) => ({ ...e, name: e.name })));
    }
    const list = found.slice(0, 20);
    if (!list.length) return { tab: number, text: `Tab ${number}: nothing on the page matches "${query}".` };
    return { tab: number, text: [`Tab ${number}: ${list.length} element${list.length === 1 ? '' : 's'} matching "${query}" (use the number with the browser tools):`, ...list.map(elementLine)].join('\n') };
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

  /** Waits for some text to appear on the page or in one of its frames, or a number of seconds (at most 30). */
  async wait(sessionId: string, args: { text?: unknown; seconds?: unknown; tab?: unknown }): Promise<TabResult> {
    const { page, number } = await this.#pick(sessionId, args.tab);
    const limit = Math.min(30, Math.max(0.5, Number(args.seconds) || (typeof args.text === 'string' ? 10 : 2))) * 1000;
    const wait = this.#o.wait ?? sleep;
    if (typeof args.text !== 'string' || !args.text) {
      await wait(limit);
      return { tab: number, text: `Tab ${number}: waited ${limit / 1000} s.` };
    }
    const code = `(document.body ? document.body.innerText : '').includes(${JSON.stringify(args.text)})`;
    const pf = pageFrames(page);
    for (let spent = 0; spent <= limit; spent += 500) {
      if ((await page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code }]).catch(() => false)) === true) return { tab: number, text: `Tab ${number}: the text is on the page.` };
      for (const f of await pf.list().catch((): FrameInfo[] => [])) {
        if ((await pf.evaluate(f, code).catch(() => false)) === true) return { tab: number, text: `Tab ${number}: the text is on the page (in a frame).` };
      }
      await wait(500);
    }
    return { tab: number, text: `Tab ${number}: the text did not appear within ${limit / 1000} s.` };
  }

  // ---- acting on a page (browser/actions.ts judges each first) ----

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

  /** Where a number the agent used points: the page or a frame (an unknown number is taken as the page's own). */
  #place(page: AgentPage, ref: unknown): RefPlace {
    const n = Number(ref);
    if (!Number.isInteger(n) || n < 1) throw new Error('ref must be an element number from browser_read or browser_find');
    return this.#book(page).byRef.get(n) ?? { local: n };
  }

  /** A frame as it is now (its session may have changed), with the list it is in. */
  async #frameNow(page: AgentPage, frameId: string): Promise<{ frame: FrameInfo; frames: FrameInfo[] } | undefined> {
    const frames = await pageFrames(page)
      .list()
      .catch((): FrameInfo[] => []);
    const frame = frames.find((f) => f.frameId === frameId);
    return frame ? { frame, frames } : undefined;
  }

  /** Runs a script where the element is (the page's isolated world, or the frame's). */
  async #inPlace(page: AgentPage, place: RefPlace, code: string): Promise<unknown> {
    if (!place.frameId) return page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code }]);
    const at = await this.#frameNow(page, place.frameId);
    if (!at) return null;
    return pageFrames(page).evaluate(at.frame, code);
  }

  /** What the element is now, scrolled into view, its middle in the page's viewport. */
  async #locate(page: AgentPage, ref: unknown): Promise<{ facts: ElementFacts | null; place: RefPlace }> {
    const place = this.#place(page, ref);
    if (!place.frameId) return { facts: asFacts(await page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: inspectScript(place.local, place.doc) }]).catch(() => null)), place };
    const at = await this.#frameNow(page, place.frameId);
    if (!at) return { facts: asFacts({ found: false }), place };
    const pf = pageFrames(page);
    await pf.scrollIntoView(at.frame, at.frames);
    const f = asFacts(await pf.evaluate(at.frame, inspectScript(place.local, place.doc)).catch(() => null));
    if (f?.found) {
      const off = await pf.offset(at.frame, at.frames);
      f.x += off.x;
      f.y += off.y;
    }
    return { facts: f, place };
  }

  /** The focused element (where a key goes), looking into the frame that has the focus. */
  async #focused(page: AgentPage): Promise<{ facts: ElementFacts | null; frame?: FrameInfo }> {
    const v = (await page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: FOCUSED_SCRIPT }]).catch(() => null)) as { inFrame?: boolean } | null;
    if (!v?.inFrame) return { facts: asFacts(v) };
    const pf = pageFrames(page);
    for (const f of await pf.list().catch((): FrameInfo[] => [])) {
      const fv = (await pf.evaluate(f, FOCUSED_SCRIPT).catch(() => null)) as { focused?: boolean; inFrame?: boolean } | null;
      if (fv?.focused && !fv.inFrame) return { facts: asFacts(fv), frame: f };
    }
    return { facts: null };
  }

  async #facts(page: AgentPage, tool: ActionTool, ref: unknown): Promise<ElementFacts | null> {
    if (tool === 'browser_press') return (await this.#focused(page)).facts;
    if (tool === 'browser_javascript') return asFacts({ found: true, page: page.getURL() });
    return (await this.#locate(page, ref)).facts;
  }

  /**
   * Before the call (a hook in the core): whether to do it, ask first (with what to say and what the element is now),
   * or leave it to the person. Nothing is done here.
   */
  async inspect(
    sessionId: string,
    args: { tool?: unknown; ref?: unknown; tab?: unknown; key?: unknown; submit?: unknown; text?: unknown; paths?: unknown; callId?: unknown },
  ): Promise<{ verdict: ReturnType<typeof judge> }> {
    const tool = String(args.tool) as ActionTool;
    if (!ACTION_TOOLS.includes(tool)) return { verdict: { action: 'allow' } };
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

  /** A file chooser the page opens while the agent acts is not shown (the system's dialog): the agent sets files instead. */
  async #noFileDialog<T>(page: AgentPage, act: () => Promise<T>): Promise<{ value: T; chooser: boolean }> {
    let chooser = false;
    const off = page.onCdp?.((method) => {
      if (method === 'Page.fileChooserOpened') chooser = true;
    });
    await page.cdp('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined);
    try {
      const value = await act();
      await (this.#o.wait ?? sleep)(150);
      return { value, chooser };
    } finally {
      off?.();
      await page.cdp('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined);
    }
  }

  async #mouse(page: AgentPage, x: number, y: number): Promise<boolean> {
    const { chooser } = await this.#noFileDialog(page, async () => {
      for (const type of ['mousePressed', 'mouseReleased']) await page.cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    });
    return chooser;
  }

  /**
   * One conversation's acting steps run one after another: a click or typing moves the focus, so two at once (the
   * model may send them in parallel) would type into each other's field. By conversation id.
   */
  readonly #lines = new Map<string, Promise<unknown>>();

  #inLine<T>(sessionId: string, step: () => Promise<T>): Promise<T> {
    const before = this.#lines.get(sessionId) ?? Promise.resolve();
    const run = before.then(step, step);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#lines.set(sessionId, settled);
    void settled.then(() => {
      if (this.#lines.get(sessionId) === settled) this.#lines.delete(sessionId);
    });
    return run;
  }

  click(sessionId: string, args: { ref?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    return this.#inLine(sessionId, () => this.#click(sessionId, args));
  }

  type(sessionId: string, args: { ref?: unknown; text?: unknown; submit?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    return this.#inLine(sessionId, () => this.#type(sessionId, args));
  }

  press(sessionId: string, args: { key?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    return this.#inLine(sessionId, () => this.#press(sessionId, args));
  }

  select(sessionId: string, args: { ref?: unknown; value?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    return this.#inLine(sessionId, () => this.#select(sessionId, args));
  }

  hover(sessionId: string, args: { ref?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    return this.#inLine(sessionId, () => this.#hover(sessionId, args));
  }

  drag(sessionId: string, args: { ref?: unknown; to_ref?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    return this.#inLine(sessionId, () => this.#drag(sessionId, args));
  }

  upload(sessionId: string, args: { ref?: unknown; paths?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    return this.#inLine(sessionId, () => this.#upload(sessionId, args));
  }

  javascript(sessionId: string, args: { code?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    return this.#inLine(sessionId, () => this.#javascript(sessionId, args));
  }

  async #click(sessionId: string, args: { ref?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    const expect = this.#expectFor(args);
    const { info, page, number } = await this.#actPage(sessionId, args.tab);
    const f = this.#still(await this.#facts(page, 'browser_click', args.ref), expect);
    if (f.tag === 'input' && f.type === 'file') throw new Error('that is a file box: set its files with browser_file_upload instead of clicking it');
    if (!expect && info.wcId !== null) this.#o.guardSubmit?.(info.wcId, 3000);
    const chooser = await this.#mouse(page, f.x, f.y);
    const note = `Clicked [${String(args.ref)}] ${f.name ? `"${f.name}"` : f.tag}.${chooser ? ' The page asked for a file (its file dialog was not shown): set the file box with browser_file_upload.' : ''}`;
    return this.#after(page, number, note);
  }

  async #type(sessionId: string, args: { ref?: unknown; text?: unknown; submit?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    const expect = this.#expectFor(args);
    const { info, page, number } = await this.#actPage(sessionId, args.tab);
    const { facts, place } = await this.#locate(page, args.ref);
    const f = this.#still(facts, expect);
    if (judge('browser_type', f).action === 'deny') throw new Error('that is a password, card number or code field: the person types it themselves');
    if (!f.editable) throw new Error(`[${String(args.ref)}] is not a text box`);
    if (typeof args.text !== 'string') throw new Error('text is required');
    // into the field (clicked, so it has the focus), what was there replaced
    await this.#mouse(page, f.x, f.y);
    await this.#inPlace(page, place, SELECT_ALL).catch(() => undefined);
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

  async #press(sessionId: string, args: { key?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    const expect = this.#expectFor(args);
    const { info, page, number } = await this.#actPage(sessionId, args.tab);
    if (expect) this.#still(await this.#facts(page, 'browser_press', undefined), expect);
    else if (info.wcId !== null) this.#o.guardSubmit?.(info.wcId, 3000);
    await this.#key(page, String(args.key ?? ''));
    return this.#after(page, number, `Pressed ${String(args.key)}.`);
  }

  async #select(sessionId: string, args: { ref?: unknown; value?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    const expect = this.#expectFor(args);
    const { info, page, number } = await this.#actPage(sessionId, args.tab);
    const { facts, place } = await this.#locate(page, args.ref);
    const f = this.#still(facts, expect);
    if (judge('browser_select', f).action === 'deny') throw new Error('that is a card or code field: the person fills it in themselves');
    const values = (Array.isArray(args.value) ? args.value : [args.value]).filter((v) => v !== undefined && v !== null).map(String);
    if (!values.length) throw new Error('value is required (an option’s value or its words)');
    if (!expect && info.wcId !== null) this.#o.guardSubmit?.(info.wcId, 3000);
    const r = (await this.#inPlace(page, place, selectScript(place.local, place.doc, values))) as { found?: boolean; select?: boolean; missing?: string[]; options?: string[]; chosen?: string[] } | null;
    if (!r?.found) throw new Error('that element is not on the page any more; read the page again (browser_read)');
    if (!r.select) throw new Error(`[${String(args.ref)}] is not a drop-down (a native <select>); click it and then the option instead`);
    if (r.missing?.length) throw new Error(`no option ${r.missing.map((m) => `"${m}"`).join(', ')}; the options: ${(r.options ?? []).map((o) => `"${o}"`).join(', ')}`);
    return this.#after(page, number, `Selected ${(r.chosen ?? []).map((c) => `"${c}"`).join(', ')} in [${String(args.ref)}].`);
  }

  async #hover(sessionId: string, args: { ref?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    const { page, number } = await this.#actPage(sessionId, args.tab);
    const f = this.#still((await this.#locate(page, args.ref)).facts, this.#expectFor(args));
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: f.x, y: f.y, button: 'none' });
    return this.#after(page, number, `Moved the pointer over [${String(args.ref)}] ${f.name ? `"${f.name}"` : f.tag}.`);
  }

  async #drag(sessionId: string, args: { ref?: unknown; to_ref?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    const expect = this.#expectFor(args);
    const { info, page, number } = await this.#actPage(sessionId, args.tab);
    const from = this.#still((await this.#locate(page, args.ref)).facts, expect);
    const to = (await this.#locate(page, args.to_ref)).facts;
    if (!to?.found) throw new Error(`[${String(args.to_ref)}] is not on the page any more; read the page again (browser_read)`);
    if (!expect && info.wcId !== null) this.#o.guardSubmit?.(info.wcId, 3000);
    // a drag the page handles itself (pointer events) goes by the mouse; an HTML drag-and-drop the browser starts is
    // caught (Input.setInterceptDrags) and dropped where it should go
    let drag: unknown;
    const off = page.onCdp?.((method, p) => {
      if (method === 'Input.dragIntercepted') drag = p.data;
    });
    await page.cdp('Input.setInterceptDrags', { enabled: true }).catch(() => undefined);
    try {
      const mouse = (type: string, x: number, y: number) => page.cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
      await mouse('mousePressed', from.x, from.y);
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        await mouse('mouseMoved', Math.round(from.x + ((to.x - from.x) * i) / steps), Math.round(from.y + ((to.y - from.y) * i) / steps));
        await (this.#o.wait ?? sleep)(16);
      }
      if (drag) {
        for (const type of ['dragEnter', 'dragOver', 'drop']) await page.cdp('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data: drag });
      }
      await mouse('mouseReleased', to.x, to.y);
    } finally {
      off?.();
      await page.cdp('Input.setInterceptDrags', { enabled: false }).catch(() => undefined);
    }
    return this.#after(page, number, `Dragged [${String(args.ref)}] ${from.name ? `"${from.name}"` : from.tag} onto [${String(args.to_ref)}] ${to.name ? `"${to.name}"` : to.tag}.`);
  }

  /** Sets the files of a file box (paths checked by the core: the conversation's folders or the person's attachments). */
  async #upload(sessionId: string, args: { ref?: unknown; paths?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    const expect = this.#expectFor(args);
    const { page, number } = await this.#actPage(sessionId, args.tab);
    const paths = (Array.isArray(args.paths) ? args.paths : []).map(String).filter(Boolean);
    if (!paths.length) throw new Error('paths is required');
    const { facts, place } = await this.#locate(page, args.ref);
    const f = this.#still(facts, expect);
    if (f.tag !== 'input' || f.type !== 'file') throw new Error(`[${String(args.ref)}] is not a file box (an input of type file); find it with browser_find or browser_read`);
    const get = `(window.__spicaRefs || [])[${place.local} - 1]`;
    if (place.frameId) {
      const at = await this.#frameNow(page, place.frameId);
      const objectId = at ? await pageFrames(page).evaluateHandle(at.frame, get) : undefined;
      if (!at || !objectId) throw new Error('that element is not on the page any more; read the page again (browser_read)');
      await page.cdp('DOM.setFileInputFiles', { files: paths, objectId }, at.frame.sessionId);
    } else {
      // our world's element, found by the protocol through a mark put on it for this moment
      const mark = `u${Math.random().toString(36).slice(2, 12)}`;
      await page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: `(() => { const el = ${get}; if (el) el.setAttribute('data-spica-upload', ${JSON.stringify(mark)}); })()` }]);
      try {
        const doc = (await page.cdp('DOM.getDocument', { depth: 0 })) as { root?: { nodeId?: number } };
        const q = (await page.cdp('DOM.querySelector', { nodeId: doc?.root?.nodeId, selector: `input[type=file][data-spica-upload="${mark}"]` })) as { nodeId?: number };
        if (!q?.nodeId) throw new Error('that element is not on the page any more; read the page again (browser_read)');
        await page.cdp('DOM.setFileInputFiles', { files: paths, nodeId: q.nodeId });
      } finally {
        await page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: `(() => { const el = ${get}; if (el) el.removeAttribute('data-spica-upload'); })()` }]).catch(() => undefined);
      }
    }
    const n = await this.#inPlace(page, place, `(() => { const el = ${get}; return el && el.files ? el.files.length : -1; })()`).catch(() => -1);
    if (n !== paths.length) throw new Error('the page did not take the files');
    const names = paths.map((p) => p.split(/[\\/]/).pop()).join(', ');
    return this.#after(page, number, `Set ${paths.length} file${paths.length === 1 ? '' : 's'} in [${String(args.ref)}]: ${names}.`);
  }

  /** Runs a script in the page itself (its own world: the page's variables and sign-ins), returns its value. */
  async #javascript(sessionId: string, args: { code?: unknown; tab?: unknown; expect?: unknown; callId?: unknown }): Promise<TabResult> {
    const expect = this.#expectFor(args);
    const { page, number } = await this.#actPage(sessionId, args.tab);
    if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('code is required');
    // asked about one site: on another one by now, it is not run
    if (expect) this.#still(asFacts({ found: true, page: page.getURL() }), expect);
    const run = page.cdp('Runtime.evaluate', { expression: args.code, replMode: true, awaitPromise: true, returnByValue: true, userGesture: true, timeout: SCRIPT_TIMEOUT_MS }) as Promise<{
      result?: { type?: string; value?: unknown; description?: string; unserializableValue?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([run, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`the script did not finish within ${SCRIPT_TIMEOUT_MS / 1000} s`)), SCRIPT_TIMEOUT_MS)))]).finally(() => clearTimeout(timer));
    if (r?.exceptionDetails) throw new Error(`the script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'error'}`);
    const res = r?.result;
    let value: string;
    if (!res || res.type === 'undefined') value = 'undefined';
    else if (res.unserializableValue) value = res.unserializableValue;
    else if (res.value !== undefined) value = typeof res.value === 'string' ? res.value : JSON.stringify(res.value, null, 2);
    else value = res.description ?? String(res.type);
    const cut = value.length > SCRIPT_RESULT_LIMIT;
    return { tab: number, text: `Tab ${number}: the script returned:\n${cut ? `${value.slice(0, SCRIPT_RESULT_LIMIT)}\n(cut at ${SCRIPT_RESULT_LIMIT} characters)` : value}` };
  }

  /** What the page wrote to its console (and its uncaught errors) since the agent opened it. */
  async console(sessionId: string, args: { tab?: unknown; pattern?: unknown; only_errors?: unknown; limit?: unknown; clear?: unknown }): Promise<TabResult> {
    const { page, number } = await this.#pick(sessionId, args.tab);
    const log = pageLog(page);
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
    const pattern = typeof args.pattern === 'string' && args.pattern ? args.pattern.toLowerCase() : '';
    const all = log.console.filter((e) => (args.only_errors === true ? e.level === 'error' || e.level === 'exception' : true) && (!pattern || e.text.toLowerCase().includes(pattern)));
    const shown = all.slice(-limit);
    if (args.clear === true) log.console.length = 0;
    if (!shown.length) return { tab: number, text: `Tab ${number}: no console messages${pattern || args.only_errors === true ? ' that match' : ''} (kept since the agent opened this tab).` };
    return { tab: number, text: [`Tab ${number}: ${shown.length}${all.length > shown.length ? ` of ${all.length}` : ''} console message${shown.length === 1 ? '' : 's'}, oldest first:`, ...shown.map((e) => lineOf(e.level, e.text, e.source))].join('\n') };
  }

  /** The requests the page made since the agent opened it, or one of them in full (sign-in data hidden). */
  async network(sessionId: string, args: { tab?: unknown; url_pattern?: unknown; limit?: unknown; request_id?: unknown }): Promise<TabResult> {
    const { page, number } = await this.#pick(sessionId, args.tab);
    const log = pageLog(page);
    if (args.request_id !== undefined && args.request_id !== null && args.request_id !== '') {
      const e = log.request(String(args.request_id));
      if (!e) throw new Error(`no request ${String(args.request_id)} kept for this tab (list them first)`);
      return { tab: number, text: await this.#requestDetail(log, e) };
    }
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
    const pattern = typeof args.url_pattern === 'string' && args.url_pattern ? args.url_pattern.toLowerCase() : '';
    const all = log.requests().filter((r) => !pattern || r.url.toLowerCase().includes(pattern));
    const shown = all.slice(-limit);
    if (!shown.length) return { tab: number, text: `Tab ${number}: no requests${pattern ? ' that match' : ''} (kept since the agent opened this tab).` };
    const line = (r: RequestEntry) => `${r.id} ${r.method} ${r.failed ? `failed: ${r.failed}` : r.status !== undefined ? String(r.status) : r.done ? 'done' : 'pending'} ${r.type} ${r.url}`;
    return {
      tab: number,
      text: [`Tab ${number}: ${shown.length}${all.length > shown.length ? ` of ${all.length}` : ''} request${shown.length === 1 ? '' : 's'}, oldest first (id method status type address; request_id gives one in full):`, ...shown.map(line)].join('\n'),
    };
  }

  async #requestDetail(log: ReturnType<typeof pageLog>, e: RequestEntry): Promise<string> {
    const headers = (h: Record<string, string> | undefined) => Object.entries(h ?? {}).map(([k, v]) => `  ${k}: ${v}`);
    const lines = [`${e.method} ${e.url}`, `Type: ${e.type}`, `Status: ${e.failed ? `failed: ${e.failed}` : e.status !== undefined ? `${e.status} ${e.statusText ?? ''}`.trim() : 'pending'}`];
    if (e.mimeType) lines.push(`Content type: ${e.mimeType}`);
    lines.push('Request headers:', ...headers(e.requestHeaders));
    if (e.postData !== undefined) lines.push('Request body:', e.postData);
    if (e.responseHeaders) lines.push('Response headers:', ...headers(e.responseHeaders));
    if (e.done && !e.failed) {
      const body = await log.body(e);
      lines.push('Response body:', body ? `${body.text}${body.cut ? `\n(cut)` : ''}` : '(not available any more)');
    }
    lines.push('(Cookies, Authorization and other sign-in data are hidden.)');
    return lines.join('\n');
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
