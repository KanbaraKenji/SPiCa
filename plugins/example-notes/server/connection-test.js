// The Notes plugin's 测试连接 page (views/connection-test.json, placement
// "settings": a tab after 详情 under 设置 › 插件 › Notes). It shows what the
// settings form cannot: a button that tries the catalog address the user filled
// in and says how it went. It stores nothing; the address itself is in the form
// (manifest.json · user_config). A service (services/connection-test.json): its
// tool is not offered to the model, only to this page.
import { createInterface } from 'node:readline';
import { readConfig } from './config.js';

const mock = process.env.SPICA_MOCK === '1';

const tools = [
  {
    name: 'test_connection',
    description: 'Try the catalog address from the settings form once and say whether it answers.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];

async function testConnection() {
  if (mock) return { text: '模拟模式：查目录用的是样例数据，不连目录服务。' };
  const url = readConfig().catalog_url;
  if (!url) return { text: '[NOT_CONFIGURED] 还没填「样例目录地址」：在「详情」里的设置中填写。', isError: true };
  const started = Date.now();
  try {
    const res = await fetch(`${url}?q=test`, { signal: AbortSignal.timeout(10_000) });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    return res.ok ? { text: `可以连接（HTTP ${res.status}，${seconds} 秒）。` } : { text: `[SERVICE_ERROR] 目录服务回了 HTTP ${res.status}。`, isError: true };
  } catch (err) {
    return { text: `[SERVICE_UNREACHABLE] 连不上目录服务：${err?.cause?.code ?? err?.name ?? 'error'}。检查地址，或 设置 › 常规 › 网络。`, isError: true };
  }
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.method === undefined) return;
  try {
    switch (msg.method) {
      case 'initialize':
        return send({
          id: msg.id,
          result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'spica-example-notes-connection-test', version: '0.1.0' } },
        });
      case 'ping':
        return send({ id: msg.id, result: {} });
      case 'tools/list':
        return send({ id: msg.id, result: { tools } });
      case 'tools/call': {
        const name = msg.params?.name;
        if (name !== 'test_connection') return send({ id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
        const r = await testConnection();
        return send({ id: msg.id, result: { content: [{ type: 'text', text: r.text }], isError: Boolean(r.isError) } });
      }
      default:
        return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  } catch (err) {
    return send({ id: msg.id, result: { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true } });
  }
});

process.stderr.write('notes connection test service ready\n');
