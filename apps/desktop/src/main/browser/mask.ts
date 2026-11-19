// Sign-in data taken out of what the agent reads of a page's traffic (browser_network) before it reaches the model:
// cookies, Authorization and other credential headers, token-like query parameters, and secret-looking fields of
// a request or response body. What is hidden reads [hidden]; the names stay, so the model still sees what was sent.

export const HIDDEN = '[hidden]';

/** Headers that carry sign-in data whatever they hold. */
const CREDENTIAL_HEADERS = /^(cookie|set-cookie|set-cookie2|authorization|proxy-authorization|www-authenticate|proxy-authenticate)$/i;
/** Header, parameter and field names that look like a secret. */
const SECRET_NAME = /token|secret|passw|passwd|pwd|api[-_]?key|apikey|auth|session|sess(id)?$|csrf|xsrf|signature|^sig$|credential|^code$|otp|cookie|private[-_]?key|client[-_]?secret/i;

export function secretName(name: string): boolean {
  return CREDENTIAL_HEADERS.test(name.trim()) || SECRET_NAME.test(name.trim());
}

/** Headers with sign-in data hidden (names kept). */
export function maskHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k] = secretName(k) ? HIDDEN : String(v);
  return out;
}

/** An address with its user name / password and token-like query values hidden. */
export function maskUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.username || u.password) {
    u.username = u.username ? 'hidden' : '';
    u.password = u.password ? 'hidden' : '';
  }
  let changed = false;
  const params = [...u.searchParams.entries()].map(([k, v]) => {
    if (!secretName(k) || !v) return [k, v] as const;
    changed = true;
    return [k, HIDDEN] as const;
  });
  if (changed) u.search = params.map(([k, v]) => `${encodeURIComponent(k)}=${v === HIDDEN ? HIDDEN : encodeURIComponent(v)}`).join('&');
  // the hash may carry tokens too (#access_token=… after a sign-in)
  if (u.hash.includes('=')) {
    const h = new URLSearchParams(u.hash.slice(1));
    let hashChanged = false;
    for (const [k, v] of [...h.entries()]) {
      if (!secretName(k) || !v) continue;
      h.set(k, HIDDEN);
      hashChanged = true;
    }
    if (hashChanged) u.hash = [...h.entries()].map(([k, v]) => `${encodeURIComponent(k)}=${v === HIDDEN ? HIDDEN : encodeURIComponent(v)}`).join('&');
  }
  return u.href.replace(/%5Bhidden%5D/g, HIDDEN);
}

function maskJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskJson);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, secretName(k) && x !== null && typeof x !== 'object' ? HIDDEN : maskJson(x)]));
  return v;
}

/** A request or response body with secret-looking fields hidden: JSON, form data, or text with key=value / "key": "value". */
export function maskBody(body: string, contentType = ''): string {
  const t = body.trim();
  if (/json/i.test(contentType) || /^[[{]/.test(t)) {
    try {
      return JSON.stringify(maskJson(JSON.parse(t)));
    } catch {
      // not JSON after all: the text rules below
    }
  }
  if (/x-www-form-urlencoded/i.test(contentType) || (/^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(t) && t.includes('='))) {
    return t
      .split('&')
      .map((pair) => {
        const at = pair.indexOf('=');
        if (at < 0) return pair;
        let name = pair.slice(0, at);
        try {
          name = decodeURIComponent(name.replace(/\+/g, ' '));
        } catch {
          // keep it as it is
        }
        return secretName(name) ? `${pair.slice(0, at)}=${HIDDEN}` : pair;
      })
      .join('&');
  }
  return body
    .replace(/("([^"\\]{1,60})"\s*:\s*)"(?:[^"\\]|\\.)*"/g, (all, head: string, name: string) => (secretName(name) ? `${head}"${HIDDEN}"` : all))
    .replace(/\b([A-Za-z_][\w-]{0,60})=([^\s&;"'<>]+)/g, (all, name: string) => (secretName(name) ? `${name}=${HIDDEN}` : all))
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${HIDDEN}`);
}
