// The built-in browser on the app's network settings (设置 › 网络): the same proxy with its exceptions, the proxy's
// user name and password when it asks, and the extra trusted certificate file (a company's TLS inspection CA).
// The core applies the same settings to its own requests (packages/core/src/net.ts); this is the Chromium side.
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

/** As networkForCore (shared/settings.ts) gives them. */
export interface BrowserNetwork {
  proxy?: { url: string; noProxy: string[] };
  caFile: string | null;
  useSystemCa: boolean;
}

/** What Session.setProxy takes. */
export type ProxySetting = { mode: 'system' } | { mode: 'fixed_servers'; proxyRules: string; proxyBypassRules: string };

/**
 * The proxy for the browser's session. No proxy in the settings: the system's (what a browser does by default;
 * Windows' proxy settings and PAC). A proxy: that one for everything but its exceptions and this machine, without the
 * user name and password in it (those are given when the proxy asks, see proxyLogin).
 */
export function proxySetting(n: BrowserNetwork): ProxySetting {
  if (!n.proxy) return { mode: 'system' };
  let u: URL;
  try {
    u = new URL(n.proxy.url.includes('://') ? n.proxy.url : `http://${n.proxy.url}`);
  } catch {
    return { mode: 'system' };
  }
  const scheme = u.protocol === 'https:' ? 'https' : u.protocol.startsWith('socks') ? u.protocol.replace(':', '') : 'http';
  const port = u.port || (scheme === 'https' ? '443' : scheme.startsWith('socks') ? '1080' : '80');
  const bypass = [...n.proxy.noProxy.map((h) => (h.startsWith('.') ? `*${h}` : h)), '<local>'];
  return {
    mode: 'fixed_servers',
    proxyRules: `${scheme}://${u.hostname}:${port}`,
    proxyBypassRules: bypass.join(','),
  };
}

/** The proxy's user name and password from its address, for the proxy's own sign-in request; null when it has none. */
export function proxyLogin(n: BrowserNetwork, asked: { host: string; port: number }): { username: string; password: string } | null {
  if (!n.proxy) return null;
  try {
    const u = new URL(n.proxy.url.includes('://') ? n.proxy.url : `http://${n.proxy.url}`);
    if (!u.username || u.hostname.toLowerCase() !== asked.host.toLowerCase()) return null;
    if (u.port && Number(u.port) !== asked.port) return null;
    return {
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  } catch {
    return null;
  }
}

/** The certificates in a PEM file (none when it cannot be read). */
export function readCas(file: string | null): X509Certificate[] {
  if (!file) return [];
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: X509Certificate[] = [];
  for (const pem of text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
    try {
      out.push(new X509Certificate(pem));
    } catch {
      // not a certificate: skipped
    }
  }
  return out;
}

/**
 * Whether a server's chain (leaf first, as PEM) leads to one of the extra trusted certificates: some certificate in
 * it was issued and signed by one of them, and every certificate up to there was issued and signed by the next one.
 * Only asked about chains Chromium did not trust for want of a known authority; names and dates it checks itself.
 */
export function chainTrusted(chain: string[], cas: X509Certificate[]): boolean {
  if (!cas.length || !chain.length) return false;
  let certs: X509Certificate[];
  try {
    certs = chain.map((p) => new X509Certificate(p));
  } catch {
    return false;
  }
  const now = Date.now();
  for (let i = 0; i < certs.length; i++) {
    const c = certs[i]!;
    if (Date.parse(c.validFrom) > now || Date.parse(c.validTo) < now) return false;
    if (cas.some((ca) => ca.ca && c.checkIssued(ca) && c.verify(ca.publicKey) && Date.parse(ca.validTo) >= now)) return true;
    const next = certs[i + 1];
    if (!next || !next.ca || !c.checkIssued(next) || !c.verify(next.publicKey)) return false;
  }
  return false;
}

/** Electron's Certificate: PEM in `data`, the issuer's in `issuerCert`. */
export interface CertificateLike {
  data: string;
  issuerCert?: CertificateLike | null;
}

export function chainOf(cert: CertificateLike): string[] {
  const out: string[] = [];
  for (let c: CertificateLike | null | undefined = cert; c && out.length < 10; c = c.issuerCert) {
    if (out.includes(c.data)) break;
    out.push(c.data);
  }
  return out;
}

/** What setCertificateVerifyProc answers: 0 trusted, -3 Chromium's own verdict. */
export function verifyAnswer(verificationResult: string, cert: CertificateLike, cas: X509Certificate[]): 0 | -3 {
  if (verificationResult !== 'net::ERR_CERT_AUTHORITY_INVALID') return -3;
  return chainTrusted(chainOf(cert), cas) ? 0 : -3;
}

/** The parts of Electron's Session used here. */
export interface NetworkSessionLike {
  setProxy(config: ProxySetting): Promise<void>;
  setCertificateVerifyProc(proc: (request: { verificationResult: string; certificate: CertificateLike }, callback: (code: number) => void) => void): void;
}

/** Applies the settings to the browser's session (again whenever they change). */
export async function applyBrowserNetwork(ses: NetworkSessionLike, n: BrowserNetwork): Promise<void> {
  const cas = readCas(n.caFile);
  ses.setCertificateVerifyProc((req, callback) => callback(verifyAnswer(req.verificationResult, req.certificate, cas)));
  await ses.setProxy(proxySetting(n));
}
