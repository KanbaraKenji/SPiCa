// Real-model team smoke: a project-manager session spawns two sub-agents in
// parallel, the user redirects one of them mid-run, and the manager's
// summary must reflect that change.
//
//   node --env-file=../../.env.local scripts/smoke-team.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatibleProvider } from '../src/providers/openai.ts';
import { Runtime } from '../src/runtime.ts';

const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
const apiKey = process.env.SPICA_OPENAI_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('missing SPICA_OPENAI_BASE_URL / SPICA_OPENAI_API_KEY');
  process.exit(2);
}
const model = process.env.SPICA_OPENAI_MODEL ?? 'deepseek-flash';

const dir = await mkdtemp(join(tmpdir(), 'spica-team-'));
await writeFile(
  join(dir, 'supplier-a.md'),
  '# Supplier A offer\nUnit price: 12.40 EUR\nLead time: 6 weeks\nWarranty: 2 years\nPayment: 30 days net\nCertified: ISO 9001\n',
);
await writeFile(
  join(dir, 'supplier-b.md'),
  '# Supplier B offer\nUnit price: 11.10 EUR\nLead time: 10 weeks\nWarranty: 1 year\nPayment: prepayment 50%\nCertified: none\n',
);

const rt = new Runtime({
  providers: [new OpenAICompatibleProvider({ id: 'openai', baseUrl, apiKey })],
  defaults: { providerId: 'openai', model, maxTokens: 1024, maxTurns: 10 },
  cwd: dir,
  budget: { perRunUsd: 0.5 },
  limits: { openai: { maxConcurrent: 3 } },
});

const log: string[] = [];
const t0 = Date.now();
const name = (id: string) => rt.session(id)?.info().title ?? id;
rt.events.on((e) => {
  const at = `${String(Date.now() - t0).padStart(6)}ms ${name(e.sessionId).padEnd(10)}`;
  if (e.type === 'tool.start') log.push(`${at} tool ▶ ${e.name} ${JSON.stringify(e.input).slice(0, 90)}`);
  if (e.type === 'child.spawned') log.push(`${at} spawned ${e.title}`);
  if (e.type === 'relay') log.push(`${at} relay ← ${e.note.slice(0, 100)}`);
  if (e.type === 'child.report') log.push(`${at} report ← ${name(e.childId)}: ${e.summary.slice(0, 80).replace(/\n/g, ' ')}`);
  if (e.type === 'run.end') log.push(`${at} run.end ${e.reason}`);
});

const pm = rt.createSession({ role: 'manager', title: 'PM' });
const run = pm.send(
  'Compare the two supplier offers in this folder (supplier-a.md and supplier-b.md). ' +
    'Spawn one sub-agent per file to summarize it (each sub-agent should read its file), wait for both, ' +
    'then give me a short recommendation.',
).done;

// When the sub-agent for supplier B starts, the user steps in and changes its focus.
let redirected = false;
rt.events.on((e) => {
  if (redirected || e.type !== 'tool.start' || e.name !== 'read_file') return;
  const s = rt.session(e.sessionId);
  if (!s || s.parentId !== pm.id || !JSON.stringify(e.input).includes('supplier-b')) return;
  redirected = true;
  log.push(`${String(Date.now() - t0).padStart(6)}ms ${'USER'.padEnd(10)} → ${s.info().title}: "Only care about payment terms and certification, ignore price."`);
  s.send('Only care about payment terms and certification, ignore price.');
});

const result = await run;
console.log(log.join('\n'));
console.log(`\nPM final answer:\n${result.text}\n`);
const traces = rt.store.listTraces();
console.log(`model calls: ${traces.length}, sessions: ${rt.sessions().length}, total ≈$${rt.ledger.globalUsd.toFixed(5)}`);
const mentions = /prepay|payment|certif|ISO/i.test(result.text);
const ok = result.reason === 'completed' && rt.children(pm.id).length === 2 && redirected && mentions;
console.log(`redirect applied: ${redirected}, summary mentions payment/certification: ${mentions} → ${ok ? 'PASS' : 'FAIL'}`);
await rm(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
