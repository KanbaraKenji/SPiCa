// Acceptance journey J6 driven only through Spica's MCP service (stdio), with
// a real model: install the example plugin → its tools appear → the agent
// calls one → disable → the tools are gone and the agent can no longer use them.
//
//   npm run journey:j6 -w @spica/plugins      (needs .env.local)
//
// Starts the core's MCP service with the plugin system as a backend extension.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '@spica/core';

const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
if (!baseUrl || !process.env.SPICA_OPENAI_API_KEY) {
  console.error('missing SPICA_OPENAI_BASE_URL / SPICA_OPENAI_API_KEY');
  process.exit(2);
}
const entry = fileURLToPath(new URL('../../core/src/host/mcp-main.ts', import.meta.url));
const example = fileURLToPath(new URL('../../../plugins/example-notes', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'spica-j6-'));
const cfgPath = join(root, 'backend.json');
await writeFile(
  cfgPath,
  JSON.stringify({
    dbPath: join(root, 'data', 'spica.db'),
    providers: [{ id: 'deepseek', kind: 'openai-compatible', baseUrl, apiKeyEnv: 'SPICA_OPENAI_API_KEY' }],
    defaults: { providerId: 'deepseek', model: process.env.SPICA_OPENAI_MODEL ?? 'deepseek-flash', maxTokens: 1000, maxTurns: 6 },
    cwd: root,
    budget: { perRunUsd: 0.2 },
    extensions: [{ module: '@spica/plugins', options: { root: join(root, 'plugins') } }],
  }),
);

const steps: { label: string; ok: boolean; note: string }[] = [];
const check = (label: string, ok: boolean, note = '') => {
  steps.push({ label, ok, note });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${note ? ` — ${note}` : ''}`);
};

const mcp = new McpStdioClient({
  name: 'spica',
  command: process.execPath,
  args: [entry, '--config', cfgPath],
  env: { SPICA_OPENAI_API_KEY: process.env.SPICA_OPENAI_API_KEY! },
  timeoutMs: 300_000,
  stderrLog: () => {},
});
type Json = Record<string, unknown>;
const call = async (name: string, args: Json = {}): Promise<Json> => {
  const r = await mcp.callTool(name, args);
  if (r.isError) throw new Error(`${name}: ${r.content}`);
  return JSON.parse(r.content) as Json;
};
const tools = async () => ((await call('spica_list_tools')) as unknown as { name: string }[]).map((t) => t.name);

try {
  await mcp.connect();
  console.log('J6 插件（经 MCP 服务）');
  check('一开始没有插件工具', !(await tools()).some((t) => t.startsWith('notes__')));

  const d = await call('spica_plugin_install', { path: example, enable: true });
  check('装上并启用示例插件', d.enabled === true, `${String(d.displayName)} ${String(d.version)}`);
  const after = await tools();
  check('工具立刻出现', after.includes('notes__write_note') && after.includes('notes__read_note'), after.filter((t) => t.startsWith('notes__')).join(', '));

  const run = await call('spica_run', {
    text: 'Save a note titled "j6" with the text "plugins work", then read it back and tell me what it says in one sentence.',
    timeout_seconds: 180,
  });
  const used = (run.toolCalls as string[]) ?? [];
  check('Agent 调了插件工具', used.includes('notes__write_note') && used.includes('notes__read_note'), `called: ${used.join(', ')}`);
  check('回答里带出笔记内容', /plugins work/i.test(String(run.answer)), String(run.answer ?? '').replace(/\s+/g, ' ').slice(0, 120));

  await call('spica_plugin_disable', { name: 'notes' });
  const gone = await tools();
  check('停用后工具消失', !gone.some((t) => t.startsWith('notes__')), gone.filter((t) => t.startsWith('notes__')).join(', ') || '(没有 notes__ 工具)');

  const run2 = await call('spica_run', {
    session_id: run.sessionId,
    text: 'Read the note "j6" again with the notebook tool. If no notebook tool is available, just say "no notebook tool".',
    timeout_seconds: 180,
  });
  const used2 = (run2.toolCalls as string[]) ?? [];
  check('停用后 Agent 也调不到', !used2.some((t) => t.startsWith('notes__')), String(run2.answer ?? '').replace(/\s+/g, ' ').slice(0, 100));
} catch (err) {
  check('脚本', false, err instanceof Error ? err.message : String(err));
} finally {
  await mcp.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
const ok = steps.length > 0 && steps.every((s) => s.ok);
console.log(ok ? 'PASS J6 插件' : 'FAIL J6 插件');
process.exit(ok ? 0 : 1);
