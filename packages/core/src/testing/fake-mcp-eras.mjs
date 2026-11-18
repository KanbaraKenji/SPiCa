// A fake MCP stdio server for the version probe (client 'auto'). Its first argument says what kind it is:
//   modern   speaks only 2026-07-28: answers server/discover, wants the version in every request's _meta
//   refuses  an older server that answers unknown methods with -32601 before initialize
//   silent   an older server that never answers unknown methods
//   future   a newer server that knows only a later version (-32022 on discover)
//   needs    modern, but tools/call answers input_required
// Every request it gets is written to stderr as one JSON line, so a test can see what was sent.
import { createInterface } from 'node:readline';

const kind = process.argv[2] ?? 'modern';
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const META = 'io.modelcontextprotocol/protocolVersion';
const tools = [{ name: 'hello', description: 'Says hello', inputSchema: { type: 'object', properties: { who: { type: 'string' } } } }];
const modern = kind === 'modern' || kind === 'needs';

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  process.stderr.write(`${JSON.stringify({ method: msg.method, meta: msg.params?._meta ?? null })}\n`);
  if (msg.id === undefined) return;
  const m = msg.method;
  if (m === 'server/discover') {
    if (kind === 'future') return send({ id: msg.id, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2027-01-01'], requested: msg.params?._meta?.[META] } } });
    if (modern) return send({ id: msg.id, result: { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'eras', version: '2.0.0' } } } });
    if (kind === 'refuses') return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${m}` } });
    return; // silent
  }
  if (modern) {
    if (msg.params?._meta?.[META] !== '2026-07-28') return send({ id: msg.id, error: { code: -32602, message: 'missing protocol version' } });
    if (m === 'tools/list') return send({ id: msg.id, result: { resultType: 'complete', tools, ttlMs: 0, cacheScope: 'public' } });
    if (m === 'tools/call') {
      if (kind === 'needs') return send({ id: msg.id, result: { resultType: 'input_required', inputRequests: { login: { method: 'elicitation/create', params: { mode: 'form', message: 'Who?' } } }, requestState: 'x' } });
      return send({ id: msg.id, result: { resultType: 'complete', content: [{ type: 'text', text: `hello ${msg.params.arguments?.who ?? ''}` }], isError: false } });
    }
    return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${m}` } });
  }
  if (m === 'initialize') return send({ id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'eras-old', version: '1.0.0' } } });
  if (m === 'tools/list') return send({ id: msg.id, result: { tools } });
  if (m === 'tools/call') return send({ id: msg.id, result: { content: [{ type: 'text', text: `hello ${msg.params.arguments?.who ?? ''}` }] } });
  send({ id: msg.id, error: { code: -32601, message: `Method not found: ${m}` } });
});
