// The client's side of an MCP server at a web address: each message a POST to that address, the answer one JSON
// object or an event stream (Streamable HTTP; 2026-07-28 without sessions, 2025-03-26..2025-11-25 with
// Mcp-Session-Id). A server that refuses the handshake's POST with 400, 404 or 405 and no MCP error is asked with a
// GET for the deprecated HTTP+SSE transport (2024-11-05): an `endpoint` event names where to POST, answers come on
// that stream. Every request goes through netFetch (the app's proxy and certificates). Header values the person
// gave (a key) are never written to the log.
import { netErrorCode, netFetch } from '../net.ts';

export type JsonRpcMessage = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: unknown };

export interface HttpWireOptions {
  name: string;
  url: string;
  /** Sent with every request (Authorization and the like). */
  headers?: Record<string, string>;
  /** A message from the server (an answer, a notification, a request of an older server). */
  onMessage(msg: JsonRpcMessage): void;
  /** A request could not get its answer (HTTP error, no connection). */
  onRequestError(id: number | string, err: Error): void;
  /** The connection is gone for good (an older server's session ended, the HTTP+SSE stream closed). */
  onLost(err: Error): void;
  /** A line of our own for the service's log (no header values in it). */
  log(line: string): void;
  /** fetch to use (tests); default netFetch. */
  fetch?: typeof fetch;
}

/** The MCP version a message says it speaks (2026-07-28 puts it in _meta), for the MCP-Protocol-Version header. */
function bodyVersion(msg: JsonRpcMessage): string | undefined {
  const meta = (msg.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const v = meta?.['io.modelcontextprotocol/protocolVersion'];
  return typeof v === 'string' ? v : undefined;
}

/** A header value as the 2026-07-28 transport wants it: plain visible ASCII as is, anything else base64 in =?base64?…?=. */
export function headerValue(value: string): string {
  const plain = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !(value.startsWith('=?base64?') && value.endsWith('?='));
  return plain ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Codes of MCP's own errors a 2026-07-28 server answers with 400 or 404: it speaks MCP, no other transport is tried. */
const MODERN_ERRORS = new Set([-32022, -32020, -32021, -32601, -32602, -32600]);

/** Read an event stream: each event's name, data and id, as they come. Comment lines (":") are skipped. */
export async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (e: { event: string; data: string }) => void): Promise<void> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let event = '';
  let data: string[] = [];
  const line = (l: string): void => {
    if (l === '') {
      if (data.length > 0) onEvent({ event: event || 'message', data: data.join('\n') });
      event = '';
      data = [];
      return;
    }
    if (l.startsWith(':')) return;
    const colon = l.indexOf(':');
    const field = colon < 0 ? l : l.slice(0, colon);
    const value = colon < 0 ? '' : l.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    // only the new part is searched for line ends (from one back: a \r\n may be split between chunks); an event of
    // tens of MB (a file in it) comes in many chunks
    const ends = /\r\n|\r|\n/g;
    ends.lastIndex = Math.max(0, buf.length - 1);
    buf += value;
    for (let m = ends.exec(buf); m; m = ends.exec(buf)) {
      line(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
      ends.lastIndex = 0;
    }
  }
  if (buf) line(buf);
  line('');
}

export class McpHttpWire {
  readonly #o: HttpWireOptions;
  readonly #fetch: typeof fetch;
  /** Requests whose answer is still coming: stopping one closes its stream (the 2026-07-28 way to cancel). */
  readonly #inFlight = new Map<number | string, AbortController>();
  /** An older server's session (Mcp-Session-Id), once it gave one. */
  #session: string | undefined;
  /** The handshake's version (older servers want it in a header after the handshake). */
  version: string | undefined;
  /** HTTP+SSE (2024-11-05): where to POST, and the stream answers come on. */
  #sse: { endpoint: URL; stream: AbortController } | undefined;
  #triedSse = false;
  #closed = false;

  constructor(options: HttpWireOptions) {
    this.#o = options;
    this.#fetch = options.fetch ?? netFetch;
  }

  /** Which transport it settled on (for the log and tests). */
  get transport(): 'streamable-http' | 'http+sse' {
    return this.#sse ? 'http+sse' : 'streamable-http';
  }

  #headers(msg: JsonRpcMessage, extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(this.#o.headers ?? {}), ...(extra ?? {}) };
    h['content-type'] = 'application/json';
    h.accept = 'application/json, text/event-stream';
    const version = bodyVersion(msg) ?? (msg.method === 'initialize' ? undefined : this.version);
    if (version) h['mcp-protocol-version'] = version;
    if (msg.method) h['mcp-method'] = msg.method;
    const p = msg.params as { name?: unknown; uri?: unknown } | undefined;
    const named = msg.method === 'tools/call' || msg.method === 'prompts/get' ? p?.name : msg.method === 'resources/read' ? p?.uri : undefined;
    if (typeof named === 'string') h['mcp-name'] = headerValue(named);
    if (this.#session) h['mcp-session-id'] = this.#session;
    return h;
  }

  /**
   * Send one message. A request's answer (or what went wrong) comes through onMessage / onRequestError; a
   * notification or our answer to the server is only logged when refused. `headers`: this message's own
   * (2026-07-28 Mcp-Param-*).
   */
  send(msg: JsonRpcMessage, headers?: Record<string, string>): void {
    if (this.#closed) return;
    void this.#send(msg, headers);
  }

  /** Stop waiting for a request's answer (its stream is closed: the 2026-07-28 way to cancel). */
  cancel(id: number | string): void {
    this.#inFlight.get(id)?.abort();
    this.#inFlight.delete(id);
  }

  async #send(msg: JsonRpcMessage, headers?: Record<string, string>): Promise<void> {
    const id = msg.method !== undefined && msg.id !== undefined && msg.id !== null ? msg.id : undefined;
    const ctl = new AbortController();
    if (id !== undefined) this.#inFlight.set(id, ctl);
    const what = msg.method ?? 'answer';
    try {
      const target = this.#sse ? this.#sse.endpoint : new URL(this.#o.url);
      const res = await this.#post(target, JSON.stringify(msg), this.#headers(msg, headers), ctl.signal);
      if (!this.#sse) {
        const session = res.headers.get('mcp-session-id');
        if (session && !this.#session) this.#session = session;
      }
      if (res.ok) {
        // the HTTP+SSE transport answers on its stream; 202 is a notification or answer taken
        if (this.#sse || res.status === 202 || res.status === 204 || id === undefined) {
          await res.body?.cancel().catch(() => undefined);
          return;
        }
        const type = res.headers.get('content-type') ?? '';
        if (/text\/event-stream/i.test(type) && res.body) {
          await readEvents(res.body, (e) => {
            if (e.event === 'message') this.#deliver(e.data);
          });
        } else {
          this.#deliver(await res.text());
        }
        return;
      }
      const body = await res.text().catch(() => '');
      // an MCP error for this request (a newer server's 400 for a version it does not speak, an unknown method)
      const mcp = parse(body);
      const own = !Array.isArray(mcp) && mcp?.error && mcp.id === id && id !== undefined;
      if (own) return this.#o.onMessage(mcp);
      const modern = !Array.isArray(mcp) && typeof (mcp?.error as { code?: unknown } | undefined)?.code === 'number' && MODERN_ERRORS.has((mcp!.error as { code: number }).code);
      if (res.status === 404 && this.#session) {
        // the older server forgot the session: a new connection is needed (its owner starts it again)
        this.#session = undefined;
        this.#lose(new Error(`MCP server "${this.#o.name}" ended its session (HTTP 404)`));
        return;
      }
      if (msg.method === 'initialize' && !this.#sse && !this.#triedSse && !modern && [400, 404, 405].includes(res.status)) {
        this.#triedSse = true;
        if (await this.#openSse()) {
          this.#inFlight.delete(id!);
          return void this.#send(msg, headers);
        }
      }
      const err = new Error(`MCP server "${this.#o.name}" answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} to ${what}`);
      this.#o.log(`[spica] ${what}: HTTP ${res.status}`);
      if (id !== undefined) this.#o.onRequestError(id, Object.assign(err, { status: res.status }));
    } catch (err) {
      if (ctl.signal.aborted) return;
      const e = this.#netError(err);
      this.#o.log(`[spica] ${what}: ${e.message}`);
      if (id !== undefined) this.#o.onRequestError(id, e);
    } finally {
      if (id !== undefined && this.#inFlight.get(id) === ctl) this.#inFlight.delete(id);
    }
  }

  #netError(err: unknown): Error {
    if (err instanceof Error && (err as { status?: unknown }).status !== undefined) return err;
    const code = netErrorCode(err);
    const detail = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    return Object.assign(new Error(`MCP server "${this.#o.name}" could not be reached (${code}): ${detail}`), { netCode: code });
  }

  /**
   * POST, following a redirect only within the same site (a key in a header must not go to another one).
   */
  async #post(url: URL, body: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    let at = url;
    for (let hop = 0; hop < 5; hop++) {
      const res = await this.#fetch(at, { method: 'POST', body, headers, signal, redirect: 'manual' });
      const location = res.headers.get('location');
      if (![301, 302, 307, 308].includes(res.status) || !location) return res;
      await res.body?.cancel().catch(() => undefined);
      const next = new URL(location, at);
      if (next.origin !== at.origin) throw Object.assign(new Error(`MCP server "${this.#o.name}" could not be reached (net.redirect): it sent the request to another site (${next.origin}); not followed`), { status: res.status });
      at = next;
    }
    throw Object.assign(new Error(`MCP server "${this.#o.name}" could not be reached (net.redirect): too many redirects`), { status: 310 });
  }

  #deliver(text: string): void {
    const m = parse(text);
    for (const one of Array.isArray(m) ? m : m ? [m] : []) {
      try {
        this.#o.onMessage(one);
      } catch {
        // a broken listener must not break the stream
      }
    }
  }

  /**
   * The deprecated HTTP+SSE transport: GET the address, wait for the `endpoint` event (where to POST; on the same
   * site only), then keep reading answers from that stream. False when the server does not speak it either.
   */
  async #openSse(): Promise<boolean> {
    const stream = new AbortController();
    const base = new URL(this.#o.url);
    const headers: Record<string, string> = { ...(this.#o.headers ?? {}), accept: 'text/event-stream' };
    let res: Response;
    try {
      res = await this.#fetch(base, { method: 'GET', headers, signal: stream.signal, redirect: 'manual' });
    } catch {
      return false;
    }
    if (!res.ok || !/text\/event-stream/i.test(res.headers.get('content-type') ?? '') || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return false;
    }
    const body = res.body;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.abort();
        resolve(false);
      }, 10_000);
      readEvents(body, (e) => {
        if (!settled) {
          if (e.event !== 'endpoint') return;
          settled = true;
          clearTimeout(timer);
          let endpoint: URL;
          try {
            endpoint = new URL(e.data.trim(), base);
          } catch {
            stream.abort();
            return resolve(false);
          }
          if (endpoint.origin !== base.origin) {
            this.#o.log(`[spica] the server named another site to send to (${endpoint.origin}); not used`);
            stream.abort();
            return resolve(false);
          }
          this.#sse = { endpoint, stream };
          this.#o.log('[spica] older server: using the HTTP+SSE transport (2024-11-05)');
          return resolve(true);
        }
        if (e.event === 'message') this.#deliver(e.data);
      }).then(
        () => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            return resolve(false);
          }
          this.#lose(new Error(`MCP server "${this.#o.name}" closed its event stream`));
        },
        (err: unknown) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            return resolve(false);
          }
          if (!stream.signal.aborted) this.#lose(this.#netError(err));
        },
      );
    });
  }

  #lose(err: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const c of this.#inFlight.values()) c.abort();
    this.#inFlight.clear();
    this.#sse?.stream.abort();
    this.#o.log(`[spica] ${err.message}`);
    this.#o.onLost(err);
  }

  /** Stop: open requests and the stream are closed; an older server's session is ended (DELETE, not waited for long). */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const c of this.#inFlight.values()) c.abort();
    this.#inFlight.clear();
    this.#sse?.stream.abort();
    const session = this.#session;
    if (!session) return;
    try {
      const res = await this.#fetch(this.#o.url, { method: 'DELETE', headers: { ...(this.#o.headers ?? {}), 'mcp-session-id': session }, signal: AbortSignal.timeout(3_000), redirect: 'manual' });
      await res.body?.cancel().catch(() => undefined);
    } catch {
      // gone already, or does not take DELETE: nothing to do
    }
  }
}

function parse(text: string): JsonRpcMessage | JsonRpcMessage[] | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as JsonRpcMessage | JsonRpcMessage[]) : undefined;
  } catch {
    return undefined;
  }
}
