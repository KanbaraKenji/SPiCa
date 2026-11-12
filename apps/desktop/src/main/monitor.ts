// 监控台's lines, kept in the main process: the only place that sees the core's own output (stdout / stderr), its
// starts, exits and restarts, the plugins' log lines (sent up by the core's process) and every event. It keeps
// the last MONITOR_CAP lines whether the page is open or not, so nothing is lost while it is closed or after the
// core crashed.
//
// Secrets are removed here, at the one way in: the saved keys and the proxy password by value, then by pattern
// (sk-…, Bearer / Basic values, Authorization headers, user:password@ in addresses, api_key= …). Nothing reaches the
// page, a copy or an export without passing through it.
import type { CoreEvent, RequestRecord } from '@spica/protocol';
import { redact } from '@spica/core';
import type { MonitorEntry, MonitorLevel, MonitorSource } from '../shared/monitor';

export const MONITOR_CAP = 5000;
/** A line longer than this is cut (a tool's whole output, a stack dump in one line). */
const MAX_TEXT = 4000;

/** Header-shaped credentials the core's patterns leave: `Authorization: <scheme> <value>`, `x-api-key: …`, cookies. */
const HEADER_SECRET = /\b((?:proxy-)?authorization|x-api-key|api-key|cookie|set-cookie)(["']?\s*[:=]\s*["']?)([^\r\n"',}]+)/gi;

/** Text with known secrets and anything that looks like one replaced by [redacted]. */
export function scrub(text: string, secrets: readonly string[]): string {
  return redact(text, secrets).replace(HEADER_SECRET, (_m, name: string, sep: string) => `${name}${sep}[redacted]`);
}

/**
 * The values to remove, from the providers the core gets (keys, client secrets and ids, header values) and the
 * proxy address in the settings (its password). A proxy that does not parse costs only its own password.
 */
export function monitorSecretsFrom(
  providers: readonly { apiKey?: string; headers?: Record<string, string>; oauth?: { clientSecret?: string; clientId?: string } }[],
  proxy: string,
): string[] {
  const out: string[] = [];
  for (const c of providers) {
    for (const v of [c.apiKey, c.oauth?.clientSecret, c.oauth?.clientId, ...Object.values(c.headers ?? {})]) if (typeof v === 'string' && v.length >= 6) out.push(v);
  }
  const p = proxy.trim();
  if (p) {
    try {
      const raw = new URL(/^[a-z]+:\/\//i.test(p) ? p : `http://${p}`).password;
      let pass = raw;
      try {
        pass = decodeURIComponent(raw);
      } catch {
        // a % that is not an escape: the password as written
      }
      if (pass) out.push(pass, raw);
    } catch {
      // not an address: whatever sits between ':' and '@' is taken for the password
      const m = /:\/\/[^:/@\s]*:([^@\s]+)@/.exec(p) ?? /^[^:/@\s]*:([^@\s]+)@/.exec(p);
      if (m?.[1]) out.push(m[1]);
    }
  }
  return [...new Set(out)];
}

/** ISO 8601 in local time with its offset (2026-11-13T02:15:40.825+08:00): the time the page shows, in copies and exports too. */
export function localIso(d: Date): string {
  const p = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${off >= 0 ? '+' : '-'}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

export interface MonitorHubOptions {
  /** Values to remove wherever they appear (keys, client secrets, the proxy password); read at every line. */
  secrets: () => readonly string[];
  cap?: number;
  now?: () => Date;
}

export class MonitorHub {
  readonly #o: MonitorHubOptions;
  #entries: MonitorEntry[] = [];
  #seq = 0;
  readonly #listeners = new Set<(e: MonitorEntry) => void>();
  /** The rest of a chunk of output that did not end in a line break yet, per stream. */
  readonly #partial = new Map<string, string>();

  constructor(o: MonitorHubOptions) {
    this.#o = o;
  }

  add(source: MonitorSource, level: MonitorLevel, text: string, sessionId?: string, at?: Date): MonitorEntry | null {
    const clean = scrub(String(text), this.#o.secrets()).replace(/\s+$/, '');
    if (!clean) return null;
    const e: MonitorEntry = {
      seq: ++this.#seq,
      at: localIso(at ?? this.#o.now?.() ?? new Date()),
      source,
      level,
      text: clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)} …[${clean.length - MAX_TEXT} chars cut]` : clean,
      ...(sessionId ? { sessionId } : {}),
    };
    this.#entries.push(e);
    const cap = this.#o.cap ?? MONITOR_CAP;
    if (this.#entries.length > cap) this.#entries.splice(0, this.#entries.length - cap);
    for (const l of this.#listeners) {
      try {
        l(e);
      } catch {
        // a listener never stops the log
      }
    }
    return e;
  }

  /** Output of a process, in chunks: one line each, a line split across chunks joined first. */
  output(stream: string, source: MonitorSource, level: MonitorLevel, chunk: string): void {
    const text = (this.#partial.get(stream) ?? '') + chunk;
    const lines = text.split(/\r?\n/);
    this.#partial.set(stream, lines.pop() ?? '');
    for (const line of lines) this.add(source, levelOf(line, level), line);
  }

  /** What is left of the streams' output (the process ended without a last line break). */
  flush(): void {
    for (const [stream, rest] of this.#partial) if (rest) this.add(stream.startsWith('core') ? 'core' : 'plugin', 'info', rest);
    this.#partial.clear();
  }

  /** Lines for the core's events worth watching: requests, tool calls, errors, the end of runs. */
  event(e: CoreEvent): void {
    const sid = e.sessionId || undefined;
    switch (e.type) {
      case 'request':
        this.add('request', requestLevel(e.record), requestText(e.record), sid);
        break;
      case 'tool.start':
        this.add('tool', 'info', `${e.name} ← ${short(e.summary ?? json(e.input), 300)}`, sid);
        break;
      case 'tool.end':
        this.add('tool', e.isError ? 'error' : 'info', `${e.name} ${e.isError ? 'failed' : 'ok'} ${e.durationMs}ms → ${short(e.preview, 300)}`, sid);
        break;
      case 'error':
        this.add('core', e.retryable ? 'warn' : 'error', `${e.code ? `[${e.code}] ` : ''}${e.message}`, sid);
        break;
      case 'budget.stop':
        this.add('core', 'warn', e.message, sid);
        break;
      case 'run.end':
        this.add('core', e.reason === 'error' ? 'error' : 'info', `run ended: ${e.reason}${e.detail ? ` (${short(e.detail, 300)})` : ''}`, sid);
        break;
      case 'runtime.configured':
        if (e.changed.length) this.add('core', 'info', `settings applied: ${e.changed.join(', ')}`);
        for (const w of e.warnings) this.add('core', 'warn', w);
        break;
      default:
        break;
    }
  }

  /** The lines kept, oldest first; with `after`, only the newer ones. */
  list(after = 0): MonitorEntry[] {
    if (!after) return [...this.#entries];
    const i = this.#entries.findIndex((e) => e.seq > after);
    return i < 0 ? [] : this.#entries.slice(i);
  }

  onAdd(listener: (e: MonitorEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** A line of output that says it is a warning or an error. */
function levelOf(line: string, fallback: MonitorLevel): MonitorLevel {
  if (/\b(error|fatal|exception|unhandled|failed)\b/i.test(line)) return 'error';
  if (/\b(warn|warning|deprecat)/i.test(line)) return fallback === 'error' ? 'error' : 'warn';
  return fallback;
}

function requestLevel(r: RequestRecord): MonitorLevel {
  if (r.status === 'ok') return 'info';
  if (r.status === 'aborted') return 'info';
  return r.httpStatus === 429 || r.retried ? 'warn' : 'error';
}

/** deepseek/deepseek-chat #2 429 gateway.rate_limited 312ms · retried */
export function requestText(r: RequestRecord): string {
  const parts = [`${r.providerId ?? '?'}/${r.model ?? '?'}`, `#${r.attempt}`, r.status === 'ok' ? String(r.httpStatus ?? 'ok') : r.status === 'aborted' ? 'aborted' : String(r.httpStatus ?? 'error')];
  if (r.errorCode) parts.push(r.errorCode);
  parts.push(`${r.durationMs}ms`);
  if (r.inputTokens !== undefined || r.outputTokens !== undefined) parts.push(`in ${r.inputTokens ?? 0} · out ${r.outputTokens ?? 0}${r.cacheReadTokens ? ` · cache ${r.cacheReadTokens}` : ''}`);
  if (r.retried) parts.push('retried');
  if (r.initiator !== 'model') parts.push(r.initiator);
  const head = parts.join(' ');
  return r.error && r.status !== 'ok' ? `${head} · ${short(r.error, 300)}` : head;
}

function short(text: string, max: number): string {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function json(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}
