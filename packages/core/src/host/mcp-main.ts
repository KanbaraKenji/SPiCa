// Standalone stdio MCP service: `node mcp-main.ts --config <file.json>`
// (or Electron's Node with ELECTRON_RUN_AS_NODE=1). The config file is a
// BackendConfig; provider keys can be given as `apiKeyEnv` (name of an
// environment variable) so no key has to be written into the file.
// stdout carries the MCP protocol only; logs go to stderr.
import { readFileSync } from 'node:fs';
import { serveMcp } from '../mcp/server.ts';
import { startBackend, type BackendConfig, type ProviderConfig } from './backend.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--config');
if (at < 0 || !args[at + 1]) {
  process.stderr.write('usage: mcp-main --config <backend-config.json>\n');
  process.exit(2);
}
const raw = JSON.parse(readFileSync(args[at + 1]!, 'utf8')) as BackendConfig;
const config: BackendConfig = {
  ...raw,
  providers: raw.providers.map((p: ProviderConfig) => (p.apiKeyEnv && process.env[p.apiKeyEnv] ? { ...p, apiKey: process.env[p.apiKeyEnv] } : p)),
};

startBackend(config).then(
  (backend) => {
    for (const w of backend.warnings) process.stderr.write(`[spica] ${w}\n`);
    process.stderr.write(`[spica] ready: ${backend.restored.sessions} sessions restored\n`);
    const server = serveMcp(backend.runtime, { input: process.stdin, output: process.stdout });
    const stop = () => {
      server.close();
      backend.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.stdin.on('end', stop);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  },
  (err: Error & { code?: string }) => {
    process.stderr.write(
      err.code === 'locked'
        ? `[spica] ${err.message}. The app is probably running; close it, or use another database for this MCP server.\n`
        : `[spica] could not start: ${err.message}\n`,
    );
    process.exit(1);
  },
);
