// Spica's MCP service over HTTP, for remote agent debugging and evaluation
// from another machine or container. A subset of MCP "Streamable HTTP":
// POST /mcp with one JSON-RPC message (or a batch), JSON reply; no server-
// initiated stream (GET answers 405) and no session ids (the service is
// stateless per request; spica_events gives the event history instead).
//
// Security boundary (docs/design/agent-core.md §18):
// - binds 127.0.0.1 unless another host is given AND allowRemote is set;
// - every request needs `Authorization: Bearer <token>` (checked first, in
//   constant time); the token is never written to traces, events or logs;
// - requests whose Origin or Host is not loopback are refused while bound to
//   loopback (protects against DNS rebinding from a web page);
// - JSON only, at most 4 MB per request.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Runtime } from '../runtime.ts';
import { mcpDispatcher, type McpServeOptions } from './server.ts';

export interface McpHttpOptions extends McpServeOptions {
  /** Default 127.0.0.1. */
  host?: string;
  /** 0 = any free port (default). */
  port?: number;
  /** Required to listen on anything but a loopback address. */
  allowRemote?: boolean;
  /** Bearer token, at least 16 characters; generated when missing. */
  token?: string;
  /** Path of the endpoint, default /mcp. */
  path?: string;
  maxBodyBytes?: number;
}

export interface McpHttpServer {
  /** e.g. http://127.0.0.1:47823/mcp */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** The bearer token clients must send. Hand it over out of band; never log it. */
  readonly token: string;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
export const isLoopback = (host: string) => LOOPBACK.has(host.toLowerCase()) || /^127\./.test(host);

/** A random token for the HTTP transport (256 bits, URL-safe). */
export function newMcpToken(): string {
  return randomBytes(32).toString('base64url');
}

const digest = (s: string) => createHash('sha256').update(s).digest();

export async function serveMcpHttp(rt: Runtime, opts: McpHttpOptions = {}): Promise<McpHttpServer> {
  const host = opts.host ?? '127.0.0.1';
  const loopback = isLoopback(host);
  if (!loopback && !opts.allowRemote) throw new Error(`refusing to listen on ${host}: set allowRemote to serve beyond this machine`);
  const token = opts.token ?? newMcpToken();
  if (token.length < 16) throw new Error('the MCP HTTP token must be at least 16 characters');
  const want = digest(token);
  const path = opts.path ?? '/mcp';
  const maxBody = opts.maxBodyBytes ?? 4 * 1024 * 1024;
  const dispatcher = mcpDispatcher(rt, opts);

  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    if (body === undefined) {
      res.writeHead(status, headers);
      return void res.end();
    }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', id: null, error: { code, message } });
  const hostname = (value: string | undefined) => {
    if (!value) return undefined;
    try {
      return new URL(value.includes('://') ? value : `http://${value}`).hostname;
    } catch {
      return '';
    }
  };

  const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
    // 1. who: the token, before anything else is looked at
    const auth = req.headers.authorization ?? '';
    const given = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? '';
    if (!given || !timingSafeEqual(digest(given), want)) {
      req.resume();
      return send(res, 401, rpcError(-32001, 'missing or wrong bearer token'), { 'www-authenticate': 'Bearer' });
    }
    // 2. from where: a page in a browser must not reach a loopback service through DNS rebinding
    if (loopback) {
      const origin = hostname(req.headers.origin);
      const h = hostname(req.headers.host);
      if ((origin !== undefined && !isLoopback(origin)) || (h !== undefined && !isLoopback(h))) {
        req.resume();
        return send(res, 403, rpcError(-32002, 'origin not allowed'));
      }
    }
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== path) {
      req.resume();
      return send(res, 404, rpcError(-32601, `not found: ${url.pathname}`));
    }
    if (req.method !== 'POST') {
      req.resume();
      return send(res, 405, rpcError(-32601, 'only POST is supported (no server-initiated stream)'), { allow: 'POST' });
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      req.resume();
      return send(res, 415, rpcError(-32700, 'content-type must be application/json'));
    }
    // 3. what: the body, bounded
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      size += c.length;
      if (size > maxBody) return send(res, 413, rpcError(-32600, `request larger than ${maxBody} bytes`), { connection: 'close' });
      chunks.push(c);
    }
    let msg: unknown;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(res, 400, rpcError(-32700, 'parse error'));
    }
    if (Array.isArray(msg)) {
      if (msg.length === 0) return send(res, 400, rpcError(-32600, 'empty batch'));
      const replies = (await Promise.all(msg.map((m) => dispatcher.handle(m)))).filter((r) => r !== undefined);
      return replies.length ? send(res, 200, replies) : send(res, 202);
    }
    const reply = await dispatcher.handle(msg);
    return reply === undefined ? send(res, 202) : send(res, 200, reply);
  };

  const server = createServer((req, res) => {
    onRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, rpcError(-32603, err instanceof Error ? err.message : String(err)));
      else res.destroy();
    });
  });
  server.requestTimeout = 0; // spica_run may wait for minutes
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const shown = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return {
    url: `http://${shown}:${port}${path}`,
    host,
    port,
    token,
    close: async () => {
      dispatcher.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
