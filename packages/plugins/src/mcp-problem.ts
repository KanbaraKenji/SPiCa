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
  | { kind: 'other' };

/** Reads the kind from the start error (the core's words) and what the service wrote. */
export function mcpProblem(error: string, log: readonly string[], command: string): McpProblem {
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
