// How the evaluation talks to Spica: only through Spica's MCP service, over
// stdio (a Spica service this run starts) or over HTTP (a running Spica, e.g.
// on another machine, reached with its URL and bearer token).
import { McpStdioClient } from '@spica/core';

export type Json = Record<string, unknown>;

/** The one thing a journey needs: call a spica_* tool and get its JSON back. */
export interface SpicaLink {
  call(name: string, args?: Json): Promise<Json>;
  /** Raw text of a tool result (for tools that return JSON Lines). */
  text(name: string, args?: Json): Promise<string>;
  close(): Promise<void>;
}

/** Start Spica's MCP service (stdio) on a backend config file. */
export async function startStdioLink(opts: { entry: string; config: string; env: Record<string, string>; timeoutMs?: number }): Promise<SpicaLink> {
  const c = new McpStdioClient({
    name: 'spica',
    command: process.execPath,
    args: [opts.entry, '--config', opts.config],
    env: opts.env,
    timeoutMs: opts.timeoutMs ?? 600_000,
    stderrLog: () => {},
  });
  await c.connect();
  const text = async (name: string, args: Json = {}) => {
    const r = await c.callTool(name, args);
    if (r.isError) throw new Error(`${name}: ${r.content}`);
    return r.content;
  };
  return {
    text,
    call: async (name, args) => JSON.parse(await text(name, args)) as Json,
    close: () => c.close(),
  };
}

/** Talk to a Spica MCP service over HTTP (POST JSON-RPC with a bearer token). */
export function httpLink(url: string, token: string): SpicaLink {
  let id = 0;
  const rpc = async (method: string, params: Json): Promise<Json> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = (await res.json()) as { result?: Json; error?: { message: string } };
    if (!res.ok || body.error) throw new Error(`${method}: HTTP ${res.status} ${body.error?.message ?? ''}`);
    return body.result ?? {};
  };
  const text = async (name: string, args: Json = {}) => {
    const r = (await rpc('tools/call', { name, arguments: args })) as { content?: { text: string }[]; isError?: boolean };
    const t = (r.content ?? []).map((c) => c.text).join('');
    if (r.isError) throw new Error(`${name}: ${t}`);
    return t;
  };
  return {
    text,
    call: async (name, args) => JSON.parse(await text(name, args)) as Json,
    close: async () => {},
  };
}
