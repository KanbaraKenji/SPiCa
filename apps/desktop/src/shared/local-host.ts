// Whether a host is this machine or the local network. Used by the built-in browser (main/browser/policy.ts: a page
// from the internet may not reach such a host) and by 设置 › MCP 服务 (shared/mcp-servers.ts: a web address there
// may be plain http).

/** An IPv4 address as four numbers, or null. */
function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/**
 * This machine or the local network: localhost names, loopback, private, link-local and carrier-grade NAT
 * addresses, IPv6 loopback, unique-local and link-local. `host` as URL.hostname gives it (IPv6 in brackets).
 */
export function isLocalHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = ipv4(h);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!h.includes(':')) return false;
  if (h === '::1' || h === '::') return true;
  // IPv4-mapped (::ffff:127.0.0.1, or as URL writes it, ::ffff:7f00:1)
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) {
    const rest = mapped[1]!;
    if (ipv4(rest)) return isLocalHost(rest);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return isLocalHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
  }
  return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
}
