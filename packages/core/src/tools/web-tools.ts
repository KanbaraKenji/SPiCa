// web_fetch and web_search. External data is fetched fresh every time (no
// cache); every request leaves a traceable record.
import type { Tool, ToolContext } from './types.ts';
import { netFetch } from '../net.ts';

const MAX_BYTES = 5_000_000;
const DEFAULT_MAX_CHARS = 40_000;
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

export interface WebFetchOptions {
  timeoutMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export function createWebFetchTool(opts: WebFetchOptions = {}): Tool {
  const doFetch = opts.fetchImpl ?? netFetch;
  return {
    untrusted: 'web',
    targetUrl: (input) => (typeof input.url === 'string' ? input.url : undefined),
    spec: {
      name: 'web_fetch',
      description:
        'Fetch a web page or HTTP resource (http/https, including intranet sites) and return its text. ' +
        'HTML is converted to plain text with links kept. Always fetches fresh; nothing is cached.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          max_chars: { type: 'integer', description: `Max characters to return. Default ${DEFAULT_MAX_CHARS}.` },
        },
        required: ['url'],
      },
    },
    async execute(input, ctx) {
      let url: URL;
      try {
        url = new URL(String(input.url));
      } catch {
        return { content: `Not a valid URL: ${String(input.url)}`, isError: true };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { content: `Only http and https URLs can be fetched (got ${url.protocol}).`, isError: true };
      }
      const maxChars = Math.max(500, Number(input.max_chars ?? DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS);
      const trace = ctx.tracer.start({
        kind: 'fetch',
        sessionId: ctx.sessionId,
        parentChain: ctx.parentChain,
        initiator: 'tool:web_fetch',
        target: url.host,
      });
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(opts.timeoutMs ?? 30_000)]);
      try {
        let res: Response | undefined;
        let current = url;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          res = await doFetch(current, {
            redirect: 'manual',
            signal,
            headers: { 'user-agent': opts.userAgent ?? 'Spica/0.1 (+agent web_fetch)', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' },
          });
          const loc = res.headers.get('location');
          if (res.status >= 300 && res.status < 400 && loc) {
            void res.body?.cancel().catch(() => {});
            current = new URL(loc, current);
            if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error(`redirected to unsupported ${current.protocol}`);
            continue;
          }
          break;
        }
        if (!res) throw new Error('no response');
        if (res.status >= 300 && res.status < 400) throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
        const { bytes, truncated } = await readCapped(res, MAX_BYTES);
        trace.finish({ status: 'ok', httpStatus: res.status, bytes: bytes.length });
        const type = res.headers.get('content-type') ?? 'unknown';
        const head = `URL: ${current.href}\nStatus: ${res.status}\nContent-Type: ${type}\n`;
        if (!/text|json|xml|javascript|csv|markdown/i.test(type) && looksBinary(bytes)) {
          return { content: `${head}\n[binary content, ${bytes.length} bytes; not shown]`, isError: res.status >= 400 };
        }
        const raw = new TextDecoder().decode(bytes);
        let text = /html/i.test(type) || /^\s*<(!doctype html|html)/i.test(raw) ? htmlToText(raw) : raw;
        let note = truncated ? `\n[download stopped at ${MAX_BYTES} bytes]` : '';
        if (text.length > maxChars) {
          note += `\n[showing first ${maxChars} of ${text.length} characters]`;
          text = text.slice(0, maxChars);
        }
        return { content: `${head}\n${text}${note}`, isError: res.status >= 400 };
      } catch (err) {
        const aborted = ctx.signal.aborted;
        const message = err instanceof Error ? err.message : String(err);
        trace.finish({ status: aborted ? 'aborted' : 'error', error: message });
        return { content: aborted ? 'Fetch stopped: the user interrupted it.' : `Fetch failed for ${url.href}: ${message}`, isError: true };
      }
    },
  };
}

async function readCapped(res: Response, cap: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    if (size >= cap) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const out = new Uint8Array(Math.min(size, cap));
  let off = 0;
  for (const p of parts) {
    const n = Math.min(p.length, out.length - off);
    out.set(p.subarray(0, n), off);
    off += n;
    if (off >= out.length) break;
  }
  return { bytes: out, truncated };
}

function looksBinary(b: Uint8Array): boolean {
  const n = Math.min(b.length, 4096);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®' };

/** Plain-text rendering of HTML: drops scripts/styles, keeps headings, lists, links. */
export function htmlToText(html: string): string {
  let s = html;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1]?.trim();
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    const t = text.replace(/<[^>]+>/g, '').trim();
    return t && !href.startsWith('#') && !href.startsWith('javascript:') ? `${t} (${href})` : t;
  });
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `);
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|header|footer|h[1-6]|ul|ol|table|blockquote|pre)>/gi, '\n\n');
  s = s.replace(/<\/tr>/gi, '\n');
  s = s.replace(/<\/(td|th)>/gi, '\t');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  s = s
    .split('\n')
    .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return title && !s.startsWith(title) ? `${title}\n\n${s}` : s;
}

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  published?: string;
}

/** A search provider. Implementations are data/plugins; the core ships one generic JSON adapter. */
export interface SearchBackend {
  id: string;
  search(query: string, opts: { count: number; signal: AbortSignal; ctx: ToolContext }): Promise<SearchResult[]>;
}

export interface JsonSearchBackendOptions {
  id: string;
  /** URL template; `{query}` and `{count}` are replaced (URL-encoded). */
  url: string;
  headers?: Record<string, string>;
  /** Dot path to the results array in the JSON response, e.g. "web.results". */
  resultsPath: string;
  /** Field names (dot paths) inside each result. */
  fields: { title: string; url: string; snippet?: string; published?: string };
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Generic adapter for search APIs that answer GET requests with JSON. */
export function jsonSearchBackend(o: JsonSearchBackendOptions): SearchBackend {
  return {
    id: o.id,
    async search(query, { count, signal }) {
      const url = o.url.replace(/\{query\}/g, encodeURIComponent(query)).replace(/\{count\}/g, String(count));
      const res = await (o.fetchImpl ?? netFetch)(url, {
        headers: { accept: 'application/json', ...o.headers },
        signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs ?? 20_000)]),
      });
      if (!res.ok) throw new Error(`search backend answered HTTP ${res.status}`);
      const json = (await res.json()) as unknown;
      const list = pick(json, o.resultsPath);
      if (!Array.isArray(list)) throw new Error(`search response has no array at "${o.resultsPath}"`);
      return list.slice(0, count).map((r) => ({
        title: String(pick(r, o.fields.title) ?? ''),
        url: String(pick(r, o.fields.url) ?? ''),
        ...(o.fields.snippet && pick(r, o.fields.snippet) ? { snippet: String(pick(r, o.fields.snippet)) } : {}),
        ...(o.fields.published && pick(r, o.fields.published) ? { published: String(pick(r, o.fields.published)) } : {}),
      }));
    },
  };
}

function pick(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const key of path.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * web_search over a configured backend. Hidden when no backend is configured,
 * or when the session uses its model's own hosted search instead.
 */
export function createWebSearchTool(backend: SearchBackend): Tool {
  return {
    untrusted: 'web',
    spec: {
      name: 'web_search',
      description:
        'Search the web. Returns titles, URLs and snippets; use web_fetch to read a result. Results are fetched fresh each time.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          count: { type: 'integer', description: 'Number of results (1-20). Default 8.' },
        },
        required: ['query'],
      },
    },
    available: (env) => !env.serverWebSearch,
    async execute(input, ctx) {
      const query = String(input.query ?? '').trim();
      if (!query) return { content: 'query is empty', isError: true };
      const count = Math.min(20, Math.max(1, Number(input.count ?? 8) || 8));
      const trace = ctx.tracer.start({
        kind: 'search',
        sessionId: ctx.sessionId,
        parentChain: ctx.parentChain,
        initiator: 'tool:web_search',
        target: backend.id,
      });
      try {
        const results = await backend.search(query, { count, signal: ctx.signal, ctx });
        trace.finish({ status: 'ok', bytes: JSON.stringify(results).length });
        if (results.length === 0) return { content: `No results for "${query}".` };
        const lines = results.map(
          (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.published ? `\n   published: ${r.published}` : ''}${r.snippet ? `\n   ${r.snippet}` : ''}`,
        );
        return { content: `Results for "${query}" (via ${backend.id}):\n${lines.join('\n')}` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        trace.finish({ status: ctx.signal.aborted ? 'aborted' : 'error', error: message });
        return { content: `Search failed: ${message}`, isError: true };
      }
    },
  };
}

export const webFetchTool = createWebFetchTool();
