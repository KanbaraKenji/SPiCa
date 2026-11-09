// Mail pipeline smoke (M6) through Spica's MCP service, with the Outlook
// plugin in mock mode (its sample mailbox of 30 messages) and a real model:
// poll → triage → the two project managers each get their own mail → they
// give suggestions; replies only as drafts, nothing is sent.
//
//   node --env-file=../../.env.local scripts/smoke-mail.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../src/mcp/client.ts';

const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
if (!baseUrl || !process.env.SPICA_OPENAI_API_KEY) {
  console.error('missing SPICA_OPENAI_BASE_URL / SPICA_OPENAI_API_KEY');
  process.exit(2);
}
const entry = fileURLToPath(new URL('../src/host/mcp-main.ts', import.meta.url));
const outlookPlugin = fileURLToPath(new URL('../../../plugins/outlook-mail', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'spica-mail-'));
await mkdir(join(root, 'plugins'), { recursive: true });
const cfgPath = join(root, 'backend.json');
await writeFile(
  cfgPath,
  JSON.stringify({
    dbPath: join(root, 'data', 'spica.db'),
    providers: [{ id: 'deepseek', kind: 'openai-compatible', baseUrl, apiKeyEnv: 'SPICA_OPENAI_API_KEY', limits: { maxConcurrent: 3 } }],
    defaults: { providerId: 'deepseek', model: process.env.SPICA_OPENAI_MODEL ?? 'deepseek-flash', maxTokens: 2000, maxTurns: 25 },
    cwd: root,
    projectsRoot: root,
    budget: { perRunUsd: 0.5 },
    extensions: [{ module: '@spica/plugins', options: { root: join(root, 'plugins'), mock: true } }],
    mail: {
      enabled: false, // polled by hand below
      batchSize: 15,
      // no sources here: the Outlook plugin declares itself a mail source when it is enabled
    },
  }),
);

const mcp = new McpStdioClient({
  name: 'spica',
  command: process.execPath,
  args: [entry, '--config', cfgPath],
  env: { SPICA_OPENAI_API_KEY: process.env.SPICA_OPENAI_API_KEY! },
  timeoutMs: 900_000,
});
type Json = Record<string, unknown>;
const call = async (name: string, args: Json = {}): Promise<Json & unknown[]> => {
  const r = await mcp.callTool(name, args);
  if (r.isError) throw new Error(`${name}: ${r.content}`);
  return JSON.parse(r.content) as Json & unknown[];
};

let ok = false;
try {
  await mcp.connect();
  await call('spica_plugin_install', { path: outlookPlugin, enable: true });
  const tools = (await call('spica_list_tools')) as unknown as { name: string }[];
  const mailTools = tools.map((t) => t.name).filter((n) => n.startsWith('outlook__'));
  console.log(`Outlook plugin (mock) tools: ${mailTools.join(', ')}`);

  const web = await call('spica_create_project', { name: 'Website Refresh', folder: 'website-refresh' });
  const move = await call('spica_create_project', { name: 'Office relocation', folder: 'office-move' });
  console.log(`projects: ${String(web.id)} Website Refresh, ${String(move.id)} Office relocation`);

  const t0 = Date.now();
  const polled = await call('spica_poll_mail');
  console.log(`poll: ${JSON.stringify(polled)} in ${Math.round((Date.now() - t0) / 1000)} s`);
  // Play the user: decline confirmations (e.g. a shell command), answer questions briefly, then let the manager continue.
  for (const p of [web, move]) {
    for (let round = 0; round < 4; round++) {
      const st = (await call('spica_wait', { session_id: p.managerSessionId, timeout_seconds: 600 })) as Json;
      const pending = (st.pending ?? []) as { kind: string; callId: string; toolName?: string }[];
      if (pending.length === 0) break;
      for (const item of pending) {
        if (item.kind === 'confirm') {
          console.log(`  (user declines ${item.toolName ?? 'an action'} for ${String(p.name)})`);
          await call('spica_confirm', { session_id: p.managerSessionId, call_id: item.callId, approved: false });
        } else {
          await call('spica_answer', { session_id: p.managerSessionId, call_id: item.callId, answer: 'Use your judgement and suggest next steps.' });
        }
      }
    }
  }

  const mail = (await call('spica_list_mail', { limit: 200 })) as unknown as {
    id: string;
    subject: string;
    status: string;
    routedTo?: string;
    triage?: { decision: string; projectId?: string; suggestion?: string };
  }[];
  const by = (pid: unknown) => mail.filter((m) => m.triage?.projectId === pid);
  const show = (label: string, list: typeof mail) => console.log(`\n${label} (${list.length}):\n${list.map((m) => `  - [${m.status}] ${m.subject}`).join('\n')}`);
  show('→ Website Refresh', by(web.id));
  show('→ Office relocation', by(move.id));
  show('new matters', mail.filter((m) => m.triage?.decision === 'new'));
  show('ignored', mail.filter((m) => m.triage?.decision === 'ignore'));
  show('still untriaged', mail.filter((m) => !m.triage));

  // each manager: only its own mail, suggestions given, drafts only
  const checks: string[] = [];
  let allGood = true;
  for (const [p, name] of [
    [web, 'Website Refresh'],
    [move, 'Office relocation'],
  ] as const) {
    const msgs = (await call('spica_get_messages', { session_id: p.managerSessionId })) as unknown as {
      kind: string;
      text?: string;
      toolCalls?: { name: string }[];
      meta?: { mails?: { id: string }[]; suggestedActions?: Record<string, unknown> };
    }[];
    const received = msgs.flatMap((m) => (m.meta?.mails ?? []).map((x) => x.id));
    const mine = by(p.id).map((m) => m.id);
    const onlyOwn = received.every((id) => mine.includes(id)) && received.length > 0;
    const calls = msgs.flatMap((m) => (m.toolCalls ?? []).map((c) => c.name));
    const suggested = calls.includes('suggest_actions');
    const sent = calls.some((c) => /send/i.test(c));
    const last = [...msgs].reverse().find((m) => m.kind === 'assistant' && m.text)?.text ?? '';
    checks.push(
      `${name}: received ${received.length} mail(s), only its own: ${onlyOwn}; suggest_actions: ${suggested}; drafts: ${calls.filter((c) => c.includes('create_draft')).length}; anything sent: ${sent}\n    last answer: ${last.replace(/\s+/g, ' ').slice(0, 200)}`,
    );
    if (!onlyOwn || !suggested || sent) {
      allGood = false;
      const st = (await call('spica_wait', { session_id: p.managerSessionId, timeout_seconds: 5 })) as Json;
      console.log(`  [debug ${name}] status ${String(st.status)}; messages:`);
      for (const m of msgs) console.log(`    ${m.kind}: ${(m.text ?? '').replace(/\s+/g, ' ').slice(0, 120)} ${(m.toolCalls ?? []).map((c) => `<${c.name}>`).join(' ')}`);
    }
  }
  console.log(`\n${checks.join('\n')}`);
  const traces = (await mcp.callTool('spica_export_traces', {})).content.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { costUsd?: number });
  console.log(`\nrequests: ${traces.length}, cost ≈$${traces.reduce((a, t) => a + (t.costUsd ?? 0), 0).toFixed(4)}`);
  ok = allGood && by(web.id).length > 0 && by(move.id).length > 0;
} catch (err) {
  console.log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await mcp.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
