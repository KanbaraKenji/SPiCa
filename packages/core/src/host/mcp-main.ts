// Standalone MCP service: `node mcp-main.ts --config <file.json>` (or
// Electron's Node with ELECTRON_RUN_AS_NODE=1). The config file is a
// BackendConfig; provider keys can be given as `apiKeyEnv` (name of an
// environment variable) so no key has to be written into the file.
//
// stdio (default): stdout carries the MCP protocol only; logs go to stderr.
// HTTP: add `--http [--port <n>] [--host <h>] [--allow-remote] [--token-file <path>]`.
//   The bearer token comes from SPICA_MCP_TOKEN, or is generated; a generated
//   token is written to --token-file, or printed once on stderr when no file is
//   given. Loopback only unless --allow-remote (see docs/design/agent-core.md §18).
import { readFileSync } from 'node:fs';
import { serveMcp } from '../mcp/server.ts';
import { startBackend, type BackendConfig, type ProviderConfig } from './backend.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
};
const cfgPath = opt('config');
if (!cfgPath) {
  process.stderr.write('usage: mcp-main --config <backend-config.json> [--http [--port <n>] [--host <h>] [--allow-remote] [--token-file <path>]]\n');
  process.exit(2);
}
const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as BackendConfig;
const http = args.includes('--http');
const tokenFile = opt('token-file');
const config: BackendConfig = {
  ...raw,
  providers: raw.providers.map((p: ProviderConfig) => (p.apiKeyEnv && process.env[p.apiKeyEnv] ? { ...p, apiKey: process.env[p.apiKeyEnv] } : p)),
  ...(http
    ? {
        mcpHttp: {
          ...raw.mcpHttp,
          tokenEnv: 'SPICA_MCP_TOKEN',
          ...(opt('port') ? { port: Number(opt('port')) } : {}),
          ...(opt('host') ? { host: opt('host')! } : {}),
          ...(args.includes('--allow-remote') ? { allowRemote: true } : {}),
          ...(tokenFile ? { tokenFile } : {}),
        },
      }
    : {}),
};

startBackend(config).then(
  (backend) => {
    for (const w of backend.warnings) process.stderr.write(`[spica] ${w}\n`);
    process.stderr.write(`[spica] ready: ${backend.restored.sessions} sessions restored\n`);
    let closeServer = () => {};
    if (http) {
      if (!backend.mcpHttp) {
        process.stderr.write('[spica] MCP over HTTP could not start\n');
        void backend.close().then(() => process.exit(1));
        return;
      }
      process.stderr.write(`[spica] MCP over HTTP at ${backend.mcpHttp.url}\n`);
      if (!process.env.SPICA_MCP_TOKEN) {
        // generated: the operator needs it once to configure the remote client
        process.stderr.write(tokenFile ? `[spica] token written to ${tokenFile}\n` : `[spica] bearer token (shown once): ${backend.mcpHttp.token}\n`);
      }
    } else {
      const server = serveMcp(backend.runtime, { input: process.stdin, output: process.stdout }, { extraTools: backend.mcpTools });
      closeServer = () => server.close();
    }
    const stop = () => {
      closeServer();
      backend.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    if (!http) process.stdin.on('end', stop);
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
