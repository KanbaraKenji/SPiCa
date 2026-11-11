// Small shared helpers.
import { randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** Sleep that rejects when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class AbortError extends Error {
  override name = 'AbortError';
}

export function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  return new AbortError(typeof reason === 'string' ? reason : 'aborted');
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * Strip things that look like credentials from text that may end up in
 * traces, events or error messages.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[redacted]');
  return out
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, '[redacted]')
    .replace(/\b(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,})\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]') // JWT
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@') // user:password@ in URLs
    .replace(/((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/("?(?:api[_-]?key|client[_-]?secret|consumer[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key|password|passwd|(?<![A-Za-z])token|(?<![A-Za-z])secret)"?\s*[:=]\s*"?)[^\s",}]+/gi, '$1[redacted]');
}

/** Placeholder for the product name in system prompts (built-in and template files); filled in every turn. */
export const APP_NAME_SLOT = '{{app}}';

export function withAppName(text: string, appName: string): string {
  return text.split(APP_NAME_SLOT).join(appName);
}

/** Field names whose values are credentials, whatever they look like. */
export const SECRET_FIELD = /^(api[_-]?key|x-api-key|apikey|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|secret[_-]?key|private[_-]?key|password|passwd|authorization|cookie|consumer[_-]?secret|consumer[_-]?key)$/i;

/** Redact every string inside a JSON-like value; values of credential-named fields are replaced outright. */
export function redactDeep(v: unknown, secrets: readonly string[] = []): unknown {
  if (typeof v === 'string') return redact(v, secrets);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, secrets));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[redact(k, secrets)] = SECRET_FIELD.test(k) && typeof x === 'string' && x ? '[redacted]' : redactDeep(x, secrets);
    return o;
  }
  return v;
}

/** Cut a string to `max` characters, noting how much was dropped. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

/** Rough token estimate used only for budget pre-checks (never for billing). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Combine several abort signals; aborts when any of them does. */
export function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => !!s);
  return AbortSignal.any(list);
}

/** Environment variable names that must never reach child processes (model keys, tokens, ...). */
export const SECRET_ENV = /(^SPICA_|API_?KEY|SECRET|TOKEN|PASSW(OR)?D|CREDENTIAL|PRIVATE_?KEY)/i;

/** What a child process inherits by default: enough to run programs and reach the network through a proxy, plus the computer and user name. */
export const DEFAULT_CHILD_ENV: readonly string[] = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'COMPUTERNAME',
  'USERNAME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/**
 * Build a child process environment. `inherit`: 'all' (the host environment
 * minus secret-looking names) or a whitelist of names (default
 * DEFAULT_CHILD_ENV). `extra` is added as given (explicit configuration).
 * Names compare case-insensitively, as on Windows.
 */
export function childEnv(inherit: 'all' | readonly string[] = DEFAULT_CHILD_ENV, extra: Record<string, string> = {}): Record<string, string> {
  const allowed = inherit === 'all' ? undefined : new Set(inherit.map((n) => n.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || SECRET_ENV.test(name)) continue;
    if (allowed && !allowed.has(name.toUpperCase())) continue;
    out[name] = value;
  }
  return { ...out, ...extra };
}
