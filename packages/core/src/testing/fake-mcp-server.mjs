// Minimal MCP server over stdio for tests: tools echo, add, fail, slow, wipe (destructive).
import { createInterface } from 'node:readline';

const tools = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
  { name: 'fail', description: 'Always reports an error', inputSchema: { type: 'object' } },
  { name: 'slow', description: 'Answers after 10 s', inputSchema: { type: 'object' } },
  { name: 'wipe', description: 'Deletes everything', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
];
// sampling tests: list the client-facing helpers too (they are callable either way)
if (process.env.FAKE_MCP_SAMPLING) {
  tools.push(
    { name: 'caps', description: 'What the client offered at initialize', inputSchema: { type: 'object' } },
    { name: 'ask', description: 'Ask the client model (sampling)', inputSchema: { type: 'object', properties: { params: { type: 'object' } } } },
  );
}
const send =(msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
process.stderr.write('fake mcp server starting\n');
process.stdout.write('this log line is not JSON and must be ignored\n');

let clientCaps = {};
let asked = 0;
const waitingAnswers = new Map(); // our request id → the tools/call id to answer

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notifications
  // an answer to a request we sent the client (sampling)
  if (!msg.method && waitingAnswers.has(msg.id)) {
    const callId = waitingAnswers.get(msg.id);
    waitingAnswers.delete(msg.id);
    return send({ id: callId, result: { content: [{ type: 'text', text: JSON.stringify(msg.error ? { error: msg.error } : { result: msg.result }) }] } });
  }
  switch (msg.method) {
    case 'initialize':
      clientCaps = msg.params.capabilities ?? {};
      return send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } });
    case 'tools/list':
      return send({ id: msg.id, result: { tools } });
    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      if (name === 'echo') return send({ id: msg.id, result: { content: [{ type: 'text', text: `echo: ${args.text}` }] } });
      if (name === 'add') return send({ id: msg.id, result: { content: [{ type: 'text', text: String(args.a + args.b) }] } });
      if (name === 'fail') return send({ id: msg.id, result: { content: [{ type: 'text', text: 'something broke' }], isError: true } });
      if (name === 'slow') return setTimeout(() => send({ id: msg.id, result: { content: [{ type: 'text', text: 'late' }] } }), 10_000);
      if (name === 'wipe') return send({ id: msg.id, result: { content: [{ type: 'text', text: 'wiped' }] } });
      // not listed: what the client offered at initialize; ask the client's model (sampling)
      if (name === 'caps') return send({ id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(clientCaps) }] } });
      if (name === 'ask') {
        const id = `srv-${++asked}`;
        waitingAnswers.set(id, msg.id);
        return send({ id, method: 'sampling/createMessage', params: args.params });
      }
      // not listed: tests read the server's environment with it
      if (name === 'env') return send({ id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(Object.fromEntries(args.names.map((n) => [n, process.env[n] ?? null]))) }] } });
      return send({ id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
