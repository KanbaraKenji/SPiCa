// A small MCP server at a web address for tests, with no real data: one tool, room_temperature, that says a made-up
// temperature for a room. It speaks one era at a time:
//   modern  2026-07-28 Streamable HTTP: server/discover, no sessions, headers checked (MCP-Protocol-Version,
//           Mcp-Method, Mcp-Name); tools/call answered as an event stream with a progress report first
//   legacy  2025-06-18 Streamable HTTP: initialize first, Mcp-Session-Id, JSON answers
//   sse     2024-11-05 HTTP+SSE: GET opens a stream whose first event names where to POST; answers on the stream
// `key`: every request must carry Authorization: Bearer <key> (401 otherwise). `tls`: { cert, key } PEM, served
// over https. `files`: also export_documents (fake-mcp-files.mjs: files inside the result). Run as a program: node
// fake-mcp-http.mjs <era> <port> [key] [--files] (prints the address); FAKE_MCP_TLS=<folder with cert.pem and
// key.pem> serves it over https.
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { exportDocuments, FILES_TOOL } from './fake-mcp-files.mjs';

const MODERN = '2026-07-28';
const LEGACY = '2025-06-18';
const TOOL = {
  name: 'room_temperature',
  description: 'The temperature in a room, in degrees Celsius.',
  inputSchema: { type: 'object', properties: { room: { type: 'string', 'x-mcp-header': 'Room' } }, required: ['room'] },
};
const answer = (args) => ({ content: [{ type: 'text', text: `${args?.room ?? 'room'}: 23.5 °C` }] });

/**
 * @param {{ era: 'modern' | 'legacy' | 'sse'; key?: string; tls?: { cert: string | Buffer; key: string | Buffer }; port?: number; files?: boolean }} o
 */
export async function startFakeMcpHttp(o) {
  /** Every request as it came: method, path, headers (lowercase), body. */
  const seen = [];
  const sessions = new Set();
  let nextSession = 1;
  /** sse era: the open streams by id. */
  const streams = new Map();

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

  const handle = (msg, era) => {
    const { id, method, params } = msg;
    if (method === 'server/discover') {
      if (era !== 'modern') return rpcError(id, -32601, 'Method not found');
      return { jsonrpc: '2.0', id, result: { resultType: 'complete', supportedVersions: [MODERN], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fake-http', version: '1.0.0' } } } };
    }
    if (method === 'initialize') {
      if (era === 'modern') return rpcError(id, -32601, 'Method not found');
      return { jsonrpc: '2.0', id, result: { protocolVersion: era === 'sse' ? '2024-11-05' : LEGACY, capabilities: { tools: {} }, serverInfo: { name: 'fake-http', version: '1.0.0' } } };
    }
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: o.files ? [TOOL, FILES_TOOL] : [TOOL] } };
    if (method === 'tools/call' && o.files && params?.name === FILES_TOOL.name) return exportDocuments(params.arguments).then((result) => ({ jsonrpc: '2.0', id, result }));
    if (method === 'tools/call') {
      if (params?.name !== TOOL.name) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      return { jsonrpc: '2.0', id, result: answer(params.arguments) };
    }
    return rpcError(id, -32601, 'Method not found');
  };

  const server = (o.tls ? createHttps.bind(null, { cert: o.tls.cert, key: o.tls.key }) : createHttp)((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      const headers = { ...req.headers };
      seen.push({ method: req.method, path: req.url, headers, body: raw });
      if (o.key && headers.authorization !== `Bearer ${o.key}`) return send(res, 401, undefined, { 'www-authenticate': 'Bearer' });
      const url = new URL(req.url, 'http://x');

      if (o.era === 'sse') {
        if (req.method === 'GET' && url.pathname === '/mcp') {
          const sid = String(nextSession++);
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.write(`: hello\n\nevent: endpoint\ndata: /messages?sid=${sid}\n\n`);
          streams.set(sid, res);
          res.on('close', () => streams.delete(sid));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/messages') {
          const stream = streams.get(url.searchParams.get('sid') ?? '');
          if (!stream) return send(res, 404, undefined);
          const msg = JSON.parse(raw);
          res.writeHead(202).end();
          if (msg.id !== undefined && msg.method) stream.write(`event: message\ndata: ${JSON.stringify(await handle(msg, 'sse'))}\n\n`);
          return;
        }
        return send(res, 405, undefined);
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        if (o.era === 'legacy' && req.method === 'DELETE' && sessions.delete(headers['mcp-session-id'])) return send(res, 200, undefined);
        return send(res, 405, undefined);
      }
      if (req.method !== 'POST' || url.pathname !== '/mcp') return send(res, 404, undefined);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send(res, 400, rpcError(null, -32700, 'Parse error'));
      }

      if (o.era === 'modern') {
        const version = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
        if (msg.method === 'initialize' || version === undefined) return send(res, 400, rpcError(msg.id ?? null, -32022, 'Unsupported protocol version', { supported: [MODERN], requested: msg.params?.protocolVersion ?? null }));
        if (headers['mcp-protocol-version'] !== version || headers['mcp-method'] !== msg.method) return send(res, 400, rpcError(msg.id ?? null, -32020, 'Header mismatch'));
        const room = msg.params?.arguments?.room;
        if (msg.method === 'tools/call' && (headers['mcp-name'] !== msg.params?.name || (room !== undefined && headers['mcp-param-room'] !== room))) return send(res, 400, rpcError(msg.id ?? null, -32020, 'Header mismatch'));
        const out = await handle(msg, 'modern');
        if (msg.method === 'tools/call') {
          // an event stream: a progress report, then the answer
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const token = msg.params?._meta?.progressToken;
          if (token !== undefined) res.write(`: working\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 2 } })}\n\n`);
          res.end(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
          return;
        }
        return send(res, out.error?.code === -32601 ? 404 : 200, out);
      }

      // legacy: a session from initialize on
      if (msg.method === 'initialize') {
        const sid = `s-${nextSession++}`;
        sessions.add(sid);
        return send(res, 200, await handle(msg, 'legacy'), { 'mcp-session-id': sid });
      }
      if (!sessions.has(headers['mcp-session-id'])) return send(res, headers['mcp-session-id'] ? 404 : 400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: Server not initialized' } });
      if (msg.id === undefined) return send(res, 202, undefined);
      if (headers['mcp-protocol-version'] !== LEGACY) return send(res, 400, rpcError(msg.id, -32000, 'Bad MCP-Protocol-Version'));
      return send(res, 200, await handle(msg, 'legacy'));
    });
  });
  await new Promise((r) => server.listen(o.port ?? 0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `${o.tls ? 'https' : 'http'}://127.0.0.1:${port}/mcp`,
    seen,
    /** legacy: forget every session (as a server that restarted). */
    forgetSessions: () => sessions.clear(),
    close: () =>
      new Promise((r) => {
        for (const s of streams.values()) s.end();
        server.closeAllConnections?.();
        server.close(() => r(undefined));
      }),
  };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/').replace(/^\//, '')}`) {
  const args = process.argv.slice(2);
  const files = args.includes('--files');
  const [era = 'modern', port = '0', key] = args.filter((a) => a !== '--files');
  // FAKE_MCP_TLS: a folder with cert.pem and key.pem (a throwaway certificate): served over https
  const tlsDir = process.env.FAKE_MCP_TLS;
  const { readFileSync } = await import('node:fs');
  const tls = tlsDir ? { cert: readFileSync(`${tlsDir}/cert.pem`), key: readFileSync(`${tlsDir}/key.pem`) } : undefined;
  const s = await startFakeMcpHttp({ era, port: Number(port), ...(key ? { key } : {}), ...(tls ? { tls } : {}), files });
  console.log(s.url);
}
