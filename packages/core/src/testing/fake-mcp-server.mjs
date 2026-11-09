// Minimal MCP server over stdio for tests: tools echo, add, fail, slow, wipe (destructive).
import { createInterface } from 'node:readline';

const tools = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
  { name: 'fail', description: 'Always reports an error', inputSchema: { type: 'object' } },
  { name: 'slow', description: 'Answers after 10 s', inputSchema: { type: 'object' } },
  { name: 'wipe', description: 'Deletes everything', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
];
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
process.stderr.write('fake mcp server starting\n');
process.stdout.write('this log line is not JSON and must be ignored\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notifications
  switch (msg.method) {
    case 'initialize':
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
      return send({ id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
