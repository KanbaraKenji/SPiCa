// Why a service the person added is not running, as a kind the settings page words in the interface language
// (the core's own message and the service's last lines stay as they are, in its log).
export type McpProblem =
  /** The command is not on this computer (or, inside a .cmd, a program it calls). */
  | { kind: 'not-found'; command: string }
  /** It quit by itself. */
  | { kind: 'exited'; code: number | null }
  /** It did not answer when started. */
  | { kind: 'timeout'; seconds: number }
  /** It crashed again and again and is left stopped. */
  | { kind: 'crash-loop'; count: number; seconds: number }
  /** A newer MCP version than Spica speaks. */
  | { kind: 'version'; versions: string[] }
  /** A web address that cannot be reached (no such host, nobody answering, a proxy in the way), or answers with an HTTP error. */
  | { kind: 'unreachable'; status?: number }
  /** A web address that wants a key (HTTP 401) and none was given. */
  | { kind: 'needs-key' }
  /** The key given is not accepted (HTTP 401 or 403). */
  | { kind: 'bad-key' }
  /** The address's certificate: not trusted, expired, or for another name. */
  | { kind: 'certificate'; reason: 'untrusted' | 'expired' | 'name' }
  | { kind: 'other' };

/** Reads the kind from the start error (the core's words) and what the service wrote. `keyGiven`: a web address with headers. */
export function mcpProblem(error: string, log: readonly string[], command: string, opts: { keyGiven?: boolean } = {}): McpProblem {
  const http = /answered HTTP (\d{3})/.exec(error);
  if (http) {
    const status = Number(http[1]);
    if (status === 401) return opts.keyGiven ? { kind: 'bad-key' } : { kind: 'needs-key' };
    if (status === 403 && opts.keyGiven) return { kind: 'bad-key' };
    return { kind: 'unreachable', status };
  }
  const net = /could not be reached \(([\w.]+)\)/.exec(error);
  if (net) {
    const code = net[1]!;
    if (code === 'tls.untrusted') return { kind: 'certificate', reason: 'untrusted' };
    if (code === 'tls.expired') return { kind: 'certificate', reason: 'expired' };
    if (code === 'tls.name_mismatch') return { kind: 'certificate', reason: 'name' };
    return { kind: 'unreachable' };
  }
  const text = `${error}\n${log.join('\n')}`;
  // cmd.exe, English and Chinese Windows: a program the .cmd calls (node for npx) is not there
  const cmd = /'([^']+)' (?:is not recognized as an internal or external command|不是内部或外部命令)/.exec(text);
  if (cmd) return { kind: 'not-found', command: cmd[1]! };
  if (/could not start MCP server "[^"]*": .*\bENOENT\b/.test(error) || /\bENOENT\b/.test(error)) return { kind: 'not-found', command };
  const late = /did not answer (?:initialize|server\/discover) within (\d+(?:\.\d+)?) s/.exec(error);
  if (late) return { kind: 'timeout', seconds: Math.round(Number(late[1])) };
  const versions = /supports only ([^;]+); Spica speaks/.exec(error);
  if (versions) return { kind: 'version', versions: versions[1]!.split(',').map((v) => v.trim()).filter(Boolean) };
  const exited = /exited \(code (-?\d+|unknown)\)/.exec(error);
  if (exited) return { kind: 'exited', code: exited[1] === 'unknown' ? null : Number(exited[1]) };
  return { kind: 'other' };
}
