// Test extension for startBackend({ extensions }): adds an agent tool, an MCP
// tool and a port method, and writes a marker file when it is closed.
import { writeFileSync } from 'node:fs';

export function attachBackend(runtime, options) {
  const remove = runtime.tools.register(
    { spec: { name: 'ext_tool', description: 'from the test extension', inputSchema: { type: 'object' } }, execute: async () => ({ content: 'ext' }) },
    'ext:test',
  );
  return {
    warnings: ['test extension attached'],
    mcpTools: [{ name: 'spica_ext_ping', description: 'test', inputSchema: { type: 'object', properties: {} }, run: async () => ({ pong: options.word }) }],
    methods: { extPing: () => `pong ${options.word}` },
    close: async () => {
      remove();
      writeFileSync(options.marker, 'closed');
    },
  };
}
