// MCP server for the Outlook plugin (stdio, newline-delimited JSON-RPC 2.0,
// no dependencies). Spica runs it with its own Node (ELECTRON_RUN_AS_NODE=1).
//
// Environment set by Spica:
//   SPICA_MOCK         "1": answer from the fictional mailbox in mock/
//   SPICA_PLUGIN_DIR   installed plugin folder (read-only)
//   SPICA_PLUGIN_DATA  folder this plugin may write to
// Logs (stderr → plugin log) carry counts, timings and folder names only.
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockBackend, MOCK_FILE } from './mock-backend.js';
import { OutlookBackend } from './outlook-backend.js';
import { TOOLS, callTool } from './tools.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const pluginDir = process.env.SPICA_PLUGIN_DIR || join(here, '..');
const mock = process.env.SPICA_MOCK === '1';
const backend = mock ? new MockBackend(MOCK_FILE(pluginDir)) : new OutlookBackend({ script: join(here, 'outlook.ps1') });
const log = (line) => process.stderr.write(`${line}\n`);

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications need no answer
  try {
    switch (msg.method) {
      case 'initialize':
        return send({
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'spica-outlook-mail', version: '0.1.0' },
          },
        });
      case 'ping':
        return send({ id: msg.id, result: {} });
      case 'tools/list':
        return send({ id: msg.id, result: { tools: TOOLS } });
      case 'tools/call': {
        const r = await callTool(backend, msg.params?.name, msg.params?.arguments ?? {}, log);
        if (!r) return send({ id: msg.id, error: { code: -32602, message: `Unknown tool: ${msg.params?.name}` } });
        return send({ id: msg.id, result: { content: [{ type: 'text', text: r.text }], isError: r.isError } });
      }
      default:
        return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  } catch (err) {
    log(`unexpected ${err?.name ?? 'Error'}`);
    return send({ id: msg.id, result: { content: [{ type: 'text', text: '[COM_ERROR] 插件内部出错，详情在插件日志里。' }], isError: true } });
  }
});

log(`outlook server ready (mock ${mock ? 'on' : 'off'})`);
