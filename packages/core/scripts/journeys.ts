// Acceptance journeys J2–J5 and J7 driven only through Spica's MCP service
// (stdio), with a real model. J6 (plugins) needs the plugin package's install
// command on the MCP surface and is not covered here.
//
//   node --env-file=../../.env.local scripts/journeys.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDocx, makeInventoryXlsx, makePdf } from '../../extract/src/testing/fixtures.ts';
import { McpStdioClient } from '../src/mcp/client.ts';

const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
if (!baseUrl || !process.env.SPICA_OPENAI_API_KEY) {
  console.error('missing SPICA_OPENAI_BASE_URL / SPICA_OPENAI_API_KEY');
  process.exit(2);
}
const entry = fileURLToPath(new URL('../src/host/mcp-main.ts', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'spica-journeys-'));
const results: { j: string; ok: boolean; note: string }[] = [];
const record = (j: string, ok: boolean, note: string) => {
  results.push({ j, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${j}: ${note}`);
};

// ---- fixtures --------------------------------------------------------------
await mkdir(join(root, 'docs'), { recursive: true });
await writeFile(join(root, 'docs', 'quote.pdf'), await makePdf([['Quotation Q-2026-117', 'Unit price: 12.40 EUR per piece', 'Valid until 2026-12-31']]));
await writeFile(join(root, 'docs', 'spec.docx'), await makeDocx({ title: 'Product spec', sections: [{ heading: 'Battery', paragraphs: ['Capacity: 4800 mAh'] }] }));
await writeFile(join(root, 'docs', 'inventory.xlsx'), await makeInventoryXlsx());
await mkdir(join(root, 'suppliers'), { recursive: true });
await writeFile(join(root, 'suppliers', 'supplier-a.md'), '# Supplier A offer\nUnit price: 12.40 EUR\nLead time: 6 weeks\nPayment: 30 days net\nCertified: ISO 9001\n');
await writeFile(join(root, 'suppliers', 'supplier-b.md'), '# Supplier B offer\nUnit price: 11.10 EUR\nLead time: 10 weeks\nPayment: prepayment 50%\nCertified: none\n');
const cfgPath = join(root, 'backend.json'); // removed at the end with the folder
await writeFile(
  cfgPath,
  JSON.stringify({
    dbPath: join(root, 'data', 'spica.db'),
    providers: [{ id: 'deepseek', kind: 'openai-compatible', baseUrl, apiKeyEnv: 'SPICA_OPENAI_API_KEY', limits: { maxConcurrent: 3 } }],
    defaults: { providerId: 'deepseek', model: process.env.SPICA_OPENAI_MODEL ?? 'deepseek-flash', maxTokens: 1500, maxTurns: 12 },
    cwd: root,
    projectsRoot: root,
    workflowsDir: fileURLToPath(new URL('../examples/workflows/', import.meta.url)),
    extractorModules: ['@spica/extract'],
    budget: { perRunUsd: 0.5 },
  }),
);

const start = async () => {
  const c = new McpStdioClient({
    name: 'spica',
    command: process.execPath,
    args: [entry, '--config', cfgPath],
    env: { SPICA_OPENAI_API_KEY: process.env.SPICA_OPENAI_API_KEY! },
    timeoutMs: 600_000,
    stderrLog: () => {},
  });
  await c.connect();
  return c;
};
type Json = Record<string, unknown>;
const call = async (c: McpStdioClient, name: string, args: Json = {}): Promise<Json> => {
  const r = await c.callTool(name, args);
  if (r.isError) throw new Error(`${name}: ${r.content}`);
  return JSON.parse(r.content) as Json;
};
const text = (v: unknown) => String(v ?? '');

let mcp = await start();
try {
  // ---- J2: read PDF / Word / Excel and answer, with file cards ----------------
  {
    const r = await call(mcp, 'spica_run', {
      text: 'Read docs/quote.pdf, docs/spec.docx and docs/inventory.xlsx in the working folder. Answer in one short line each: the unit price in the quote, the battery capacity in the spec, and the quantity of 无线键盘 in the inventory.',
      timeout_seconds: 300,
    });
    const answer = text(r.answer);
    const msgs = (await call(mcp, 'spica_get_messages', { session_id: r.sessionId })) as unknown as { meta?: { fileCards?: Record<string, { kind: string }> } }[];
    const kinds = msgs.flatMap((m) => Object.values(m.meta?.fileCards ?? {}).map((c) => c.kind));
    const ok = /12[.,]40/.test(answer) && /4800/.test(answer) && /150/.test(answer) && ['pdf', 'docx', 'xlsx'].every((k) => kinds.includes(k));
    record('J2 读文件', ok, `answer: ${answer.replace(/\s+/g, ' ').slice(0, 160)} | file cards: ${kinds.join(', ')}`);
  }

  // ---- J3 + J4: project, two sub-agents, user redirect in one ------------------
  {
    const top = await call(mcp, 'spica_get_top_session');
    const p = await call(mcp, 'spica_create_project', {
      name: 'Supplier choice',
      folder: 'suppliers',
      workflow: 'product-development',
      brief:
        'Compare the two supplier offers in the project folder (supplier-a.md, supplier-b.md): start one sub-agent per file to summarize it, wait for both with wait_agents, then recommend one supplier.',
    });
    let since = 0;
    let redirected = '';
    const t0 = Date.now();
    while (!redirected && Date.now() - t0 < 180_000) {
      const events = (await call(mcp, 'spica_events', { since })) as unknown as { seq: number; type: string; sessionId: string; name?: string; input?: unknown }[];
      for (const e of events) {
        since = Math.max(since, e.seq);
        if (!redirected && e.type === 'tool.start' && e.name === 'read_file' && JSON.stringify(e.input).includes('supplier-b') && e.sessionId !== p.managerSessionId) {
          redirected = e.sessionId;
          await call(mcp, 'spica_send', { session_id: e.sessionId, text: 'Only payment terms and certification matter. Ignore price.' });
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    const done = await call(mcp, 'spica_wait', { session_id: p.managerSessionId, wait_for_subagents: true, timeout_seconds: 300 });
    // the manager may finish its first run before the redirect lands; wait again for the follow-up
    await new Promise((r) => setTimeout(r, 1500));
    const again = await call(mcp, 'spica_wait', { session_id: p.managerSessionId, wait_for_subagents: true, timeout_seconds: 300 });
    // everything the manager wrote (the last message can be a follow-up question)
    const pmMsgs = (await call(mcp, 'spica_get_messages', { session_id: p.managerSessionId })) as unknown as { kind: string; text?: string }[];
    const answer = pmMsgs
      .filter((m) => m.kind === 'assistant' && m.text)
      .map((m) => m.text)
      .join('\n') || text(again.answer ?? done.answer);
    const subs = (again.subAgents as unknown[]).length;
    record('J3 建项目', subs >= 2 && answer.length > 0, `project ${text(p.name)} under top ${text(top.id).slice(0, 12)}; sub-agents ${subs}`);
    const followed = /payment|prepay|付款/i.test(answer) && /certif|ISO|认证/i.test(answer) && /user|sub-agent|子|said|instruction|you (decided|asked|wanted)|your (decision|instruction)|as you/i.test(answer);
    record('J4 插话', !!redirected && followed, `redirected=${!!redirected}; manager: ${answer.replace(/\s+/g, ' ').slice(-260)}`);
  }

  // ---- J5: question card, then confirmation of an irreversible action ---------
  {
    const s = await call(mcp, 'spica_create_session', {});
    let r = await call(mcp, 'spica_run', {
      session_id: s.id,
      text: 'First use ask_user to ask me which single word to print. After I answer, use run_command to run exactly: Write-Output <that word>. Then tell me the output.',
      timeout_seconds: 180,
    });
    const ask = (r.pending as { kind: string; callId: string }[]).find((x) => x.kind === 'ask');
    if (ask) {
      await call(mcp, 'spica_answer', { session_id: s.id, call_id: ask.callId, answer: 'Orion' });
      r = await call(mcp, 'spica_wait', { session_id: s.id, timeout_seconds: 180 });
    }
    const confirm = (r.pending as { kind: string; callId: string }[]).find((x) => x.kind === 'confirm');
    if (confirm) {
      await call(mcp, 'spica_confirm', { session_id: s.id, call_id: confirm.callId, approved: true });
      r = await call(mcp, 'spica_wait', { session_id: s.id, timeout_seconds: 180 });
    }
    record('J5 提问与确认', !!ask && !!confirm && /Orion/.test(text(r.answer)), `asked=${!!ask} confirmed=${!!confirm} answer: ${text(r.answer).slice(0, 120)}`);
  }

  // ---- J7: stop the backend mid-run, start again, resume -----------------------
  {
    const s = await call(mcp, 'spica_create_session', {});
    await call(mcp, 'spica_send', { session_id: s.id, text: 'Read docs/quote.pdf, then docs/spec.docx, then docs/inventory.xlsx, one after another, and summarize each in one line.' });
    let since = 0;
    const t0 = Date.now();
    let started = false;
    while (!started && Date.now() - t0 < 120_000) {
      const events = (await call(mcp, 'spica_events', { since, session_id: s.id })) as unknown as { seq: number; type: string }[];
      for (const e of events) {
        since = Math.max(since, e.seq);
        if (e.type === 'tool.start' || e.type === 'thinking.delta' || e.type === 'status') started = true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    await mcp.close(); // the app is closed mid-run
    mcp = await start();
    const sessions = (await call(mcp, 'spica_list_sessions')) as unknown as { id: string; status: string }[];
    const mine = sessions.find((x) => x.id === s.id);
    const projects = (await call(mcp, 'spica_list_projects')) as unknown as unknown[];
    let resumed = '';
    if (mine?.status === 'interrupted') {
      await call(mcp, 'spica_resume', { session_id: s.id });
      resumed = text((await call(mcp, 'spica_wait', { session_id: s.id, timeout_seconds: 300 })).answer);
    }
    record(
      'J7 恢复',
      (mine?.status === 'interrupted' && resumed.length > 0) || mine?.status === 'idle',
      `after restart: ${sessions.length} sessions, ${projects.length} project(s), this one ${mine?.status}; ${resumed ? `resumed: ${resumed.replace(/\s+/g, ' ').slice(0, 100)}` : ''}`,
    );
  }
} catch (err) {
  record('script', false, err instanceof Error ? err.message : String(err));
} finally {
  const traces = await mcp.callTool('spica_export_traces', {}).catch(() => ({ content: '' }));
  const lines = traces.content.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { costUsd?: number; kind: string });
  const cost = lines.reduce((a, t) => a + (t.costUsd ?? 0), 0);
  console.log(`\nmodel/tool requests: ${lines.length}, cost ≈$${cost.toFixed(4)} (this database: J7 restart onwards included)`);
  await mcp.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
  const ok = results.length > 0 && results.every((r) => r.ok);
  console.log(ok ? 'ALL PASS' : 'SOME FAILED');
  process.exit(ok ? 0 : 1);
}
