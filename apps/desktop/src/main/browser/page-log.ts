// What a page of the agent's has written to its console and the requests it has made, kept from the time the agent
// opened it (browser_console, browser_network). Collected through the DevTools protocol, the page and the frames in
// other processes alike, in a buffer of a fixed size (the oldest go first). Requests are kept with sign-in data in
// them hidden (mask.ts); a response body is fetched only when asked for, and hidden the same way.
import type { AgentPage } from './agent';
import { pageFrames } from './frames';
import { maskBody, maskHeaders, maskUrl } from './mask';

export const CONSOLE_LIMIT = 500;
export const NETWORK_LIMIT = 500;
/** Most characters of a response body given back. */
export const BODY_LIMIT = 20_000;

export interface ConsoleEntry {
  /** log, info, warning, error, debug; exception for an uncaught error. */
  level: string;
  text: string;
  /** Where it came from (script address:line), when told. */
  source?: string;
  at: number;
}

export interface RequestEntry {
  id: string;
  sessionId?: string;
  url: string;
  method: string;
  type: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  failed?: string;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  done: boolean;
  at: number;
}

interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
}

function remoteText(o: RemoteObject): string {
  if (o.unserializableValue) return o.unserializableValue;
  if (o.type === 'string') return String(o.value);
  if ('value' in o && o.value !== undefined) return typeof o.value === 'object' ? JSON.stringify(o.value) : String(o.value);
  return o.description ?? o.type ?? '';
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export class PageLog {
  readonly console: ConsoleEntry[] = [];
  readonly #requests = new Map<string, RequestEntry>();
  readonly #page: AgentPage;

  constructor(page: AgentPage) {
    this.#page = page;
    const turnOn = async (sessionId?: string) => {
      for (const m of ['Runtime.enable', 'Log.enable', 'Network.enable']) await page.cdp(m, undefined, sessionId).catch(() => undefined);
    };
    page.onAttached?.(() => turnOn());
    pageFrames(page).onFrameSession((sid) => void turnOn(sid));
    page.onCdp?.((method, p, sessionId) => this.#event(method, p, sessionId));
  }

  /** Starts collecting now (attaches the protocol if it is not yet). */
  async start(): Promise<void> {
    await this.#page.cdp('Runtime.enable').catch(() => undefined);
    await this.#page.cdp('Log.enable').catch(() => undefined);
    await this.#page.cdp('Network.enable').catch(() => undefined);
  }

  #push(e: ConsoleEntry): void {
    this.console.push(e);
    if (this.console.length > CONSOLE_LIMIT) this.console.splice(0, this.console.length - CONSOLE_LIMIT);
  }

  #event(method: string, p: Record<string, unknown>, sessionId?: string): void {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const args = Array.isArray(p.args) ? (p.args as RemoteObject[]) : [];
        const frame = (p.stackTrace as { callFrames?: { url?: string; lineNumber?: number }[] } | undefined)?.callFrames?.[0];
        const type = String(p.type ?? 'log');
        this.#push({ level: type === 'warning' ? 'warning' : type === 'error' || type === 'assert' ? 'error' : type, text: clip(args.map(remoteText).join(' '), 2000), ...(frame?.url ? { source: `${frame.url}:${(frame.lineNumber ?? 0) + 1}` } : {}), at: Date.now() });
        return;
      }
      case 'Runtime.exceptionThrown': {
        const d = (p.exceptionDetails ?? {}) as { text?: string; url?: string; lineNumber?: number; exception?: RemoteObject };
        this.#push({ level: 'exception', text: clip(d.exception?.description ?? d.text ?? 'Uncaught error', 2000), ...(d.url ? { source: `${d.url}:${(d.lineNumber ?? 0) + 1}` } : {}), at: Date.now() });
        return;
      }
      case 'Log.entryAdded': {
        const e = (p.entry ?? {}) as { level?: string; text?: string; url?: string; lineNumber?: number; source?: string };
        // console calls come through Runtime already
        if (e.source === 'console-api') return;
        this.#push({ level: e.level === 'verbose' ? 'debug' : String(e.level ?? 'info'), text: clip(String(e.text ?? ''), 2000), ...(e.url ? { source: `${e.url}${e.lineNumber !== undefined ? `:${e.lineNumber + 1}` : ''}` } : {}), at: Date.now() });
        return;
      }
      case 'Network.requestWillBeSent': {
        const r = (p.request ?? {}) as { url?: string; method?: string; headers?: Record<string, unknown>; postData?: string };
        const id = `${sessionId ?? ''}:${String(p.requestId)}`;
        const ct = Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
        this.#requests.set(id, {
          id,
          ...(sessionId ? { sessionId } : {}),
          url: maskUrl(String(r.url ?? '')),
          method: String(r.method ?? 'GET'),
          type: String(p.type ?? 'Other'),
          requestHeaders: maskHeaders(r.headers),
          ...(typeof r.postData === 'string' ? { postData: clip(maskBody(r.postData, String(ct ?? '')), 4000) } : {}),
          done: false,
          at: Date.now(),
        });
        if (this.#requests.size > NETWORK_LIMIT) this.#requests.delete(this.#requests.keys().next().value!);
        return;
      }
      case 'Network.responseReceived': {
        const e = this.#requests.get(`${sessionId ?? ''}:${String(p.requestId)}`);
        const r = (p.response ?? {}) as { status?: number; statusText?: string; mimeType?: string; headers?: Record<string, unknown> };
        if (!e) return;
        e.status = Number(r.status) || 0;
        if (r.statusText) e.statusText = String(r.statusText);
        if (r.mimeType) e.mimeType = String(r.mimeType);
        e.responseHeaders = maskHeaders(r.headers);
        return;
      }
      case 'Network.loadingFinished':
      case 'Network.loadingFailed': {
        const e = this.#requests.get(`${sessionId ?? ''}:${String(p.requestId)}`);
        if (!e) return;
        e.done = true;
        if (method === 'Network.loadingFailed') e.failed = String(p.errorText ?? 'failed') + (p.blockedReason ? ` (${String(p.blockedReason)})` : '');
        return;
      }
    }
  }

  requests(): RequestEntry[] {
    return [...this.#requests.values()];
  }

  request(id: string): RequestEntry | undefined {
    return this.#requests.get(id) ?? [...this.#requests.values()].find((r) => r.id.endsWith(`:${id}`));
  }

  /** A response's body (text), sign-in data hidden; undefined when the page no longer has it. */
  async body(e: RequestEntry): Promise<{ text: string; cut: boolean } | undefined> {
    const raw = e.id.slice(e.id.indexOf(':') + 1);
    const r = (await this.#page.cdp('Network.getResponseBody', { requestId: raw }, e.sessionId).catch(() => undefined)) as { body?: string; base64Encoded?: boolean } | undefined;
    if (!r || typeof r.body !== 'string') return undefined;
    if (r.base64Encoded) return { text: `(binary, ${Math.round((r.body.length * 3) / 4)} bytes)`, cut: false };
    const masked = maskBody(r.body, e.mimeType ?? '');
    return { text: masked.slice(0, BODY_LIMIT), cut: masked.length > BODY_LIMIT };
  }

  /** Drops what was collected (the page went somewhere new and the agent asked to start over). */
  clear(): void {
    this.console.length = 0;
    this.#requests.clear();
  }
}

const logs = new WeakMap<AgentPage, PageLog>();

export function pageLog(page: AgentPage): PageLog {
  let l = logs.get(page);
  if (!l) logs.set(page, (l = new PageLog(page)));
  return l;
}
