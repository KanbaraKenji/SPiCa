// Minimal MCP stdio client for the tests: starts the plugin's server the way
// Spica does (same Node, ELECTRON_RUN_AS_NODE=1, hidden window) and calls tools.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));
const SERVER = fileURLToPath(new URL('../server/index.js', import.meta.url));

export function startServer(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: PLUGIN_DIR,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPICA_PLUGIN_DIR: PLUGIN_DIR, ...env },
  });
  let buf = '';
  let next = 0;
  const waiting = new Map();
  const logs = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => logs.push(...String(d).split('\n').filter(Boolean)));
  const rpc = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return {
    logs,
    rpc,
    async init() {
      return rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    },
    async tools() {
      return (await rpc('tools/list')).result.tools;
    },
    /** Call a tool; returns { text, isError, json } (json is parsed after the mock line, if any). */
    async call(name, args = {}) {
      const r = await rpc('tools/call', { name, arguments: args });
      const text = r.result?.content?.[0]?.text ?? '';
      const body = text.replace(/^\[sample data — mock mode\]\n/, '');
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
      return { text, isError: !!r.result?.isError, json, raw: r };
    },
    stop() {
      child.kill();
    },
  };
}
