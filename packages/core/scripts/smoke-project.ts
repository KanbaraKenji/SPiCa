// Real-model smoke for projects and the three-tier team (J3 + J4 shape):
// the top-level agent creates a project, its manager spawns two sub-agents,
// the user redirects one of them, and the manager's result must follow it.
//
//   node --env-file=../../.env.local scripts/smoke-project.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_MANAGER_TEMPLATE, TOP_TEMPLATE } from '../src/projects.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai.ts';
import { Runtime } from '../src/runtime.ts';

const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
const apiKey = process.env.SPICA_OPENAI_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('missing SPICA_OPENAI_BASE_URL / SPICA_OPENAI_API_KEY');
  process.exit(2);
}
const model = process.env.SPICA_OPENAI_MODEL ?? 'deepseek-flash';

const root = await mkdtemp(join(tmpdir(), 'spica-projects-'));
const folder = join(root, 'supplier-choice');
await mkdir(folder, { recursive: true });
await writeFile(join(folder, 'supplier-a.md'), '# Supplier A offer\nUnit price: 12.40 EUR\nLead time: 6 weeks\nPayment: 30 days net\nCertified: ISO 9001\n');
await writeFile(join(folder, 'supplier-b.md'), '# Supplier B offer\nUnit price: 11.10 EUR\nLead time: 10 weeks\nPayment: prepayment 50%\nCertified: none\n');

// Explicit tool lists so a model cannot stall the smoke on run_command's confirmation.
const fileTools = ['read_file', 'grep', 'glob', 'list_dir'];
const rt = new Runtime({
  providers: [new OpenAICompatibleProvider({ id: 'openai', baseUrl, apiKey })],
  defaults: { providerId: 'openai', model, maxTokens: 1500, maxTurns: 12 },
  cwd: root,
  projectsRoot: root,
  workflowsDir: fileURLToPath(new URL('../examples/workflows/', import.meta.url)),
  budget: { perRunUsd: 0.5 },
  limits: { openai: { maxConcurrent: 3 } },
  templates: [
    { ...TOP_TEMPLATE, tools: ['create_project', 'list_projects', 'open_project', 'message_agent'] },
    {
      ...PROJECT_MANAGER_TEMPLATE,
      tools: [...fileTools, 'project_status', 'set_stage', 'add_work_object', 'list_work_objects', 'spawn_agent', 'message_agent', 'wait_agents', 'record_decision'],
    },
  ],
});

const t0 = Date.now();
const log: string[] = [];
const name = (id: string) => rt.session(id)?.info().title ?? (rt.session(id)?.info().role === 'top' ? 'TOP' : id.slice(0, 10));
rt.events.on((e) => {
  const at = `${String(Date.now() - t0).padStart(6)}ms ${name(e.sessionId).slice(0, 22).padEnd(22)}`;
  if (e.type === 'tool.start') log.push(`${at} tool ▶ ${e.name} ${JSON.stringify(e.input).slice(0, 80)}`);
  if (e.type === 'project.created') log.push(`${at} project created: ${e.project.name} → ${e.project.folder}`);
  if (e.type === 'relay') log.push(`${at} relay ← ${e.note.slice(0, 110)}`);
  if (e.type === 'child.report') log.push(`${at} report ← ${name(e.childId)}`);
  if (e.type === 'run.end') log.push(`${at} run.end ${e.reason}`);
});

// The user steps into the sub-agent for supplier B as soon as it starts reading.
let redirected = false;
rt.events.on((e) => {
  if (redirected || e.type !== 'tool.start' || e.name !== 'read_file' || !JSON.stringify(e.input).includes('supplier-b')) return;
  const s = rt.session(e.sessionId);
  if (!s || s.info().role !== 'worker') return;
  redirected = true;
  log.push(`${String(Date.now() - t0).padStart(6)}ms ${'USER'.padEnd(22)} → ${s.info().title}: "Only payment terms and certification matter. Ignore price."`);
  s.send('Only payment terms and certification matter. Ignore price.');
});

const top = rt.top();
await top.send(
  'Create a project named "Supplier choice" in the folder "supplier-choice" with the product-development workflow. ' +
    'Brief for its project manager: compare the two supplier offers in the project folder (supplier-a.md, supplier-b.md); ' +
    'start one sub-agent per file to summarize it, wait for both, then recommend one supplier.',
).done;

const project = rt.listProjects()[0];
if (!project) {
  console.log(log.join('\n'));
  console.log('FAIL: no project was created');
  process.exit(1);
}
const manager = rt.session(project.managerSessionId)!;
// wait until the manager and its sub-agents are done
for (let i = 0; i < 600; i++) {
  await manager.settled();
  const busy = rt.children(manager.id).some((c) => c.running) || manager.running;
  if (!busy && manager.messages().some((m) => m.role === 'assistant')) break;
  await new Promise((r) => setTimeout(r, 500));
}
const final = [...manager.messages()].reverse().find((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text'));
const text = final ? final.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : '';
console.log(log.join('\n'));
console.log(`\nproject: ${project.name} (${project.folder}), stage ${rt.getProject(project.id)?.stage}, sub-agents ${rt.children(manager.id).length}`);
console.log(`\nproject manager's answer:\n${text}\n`);
const followed = /payment|prepay/i.test(text) && /certif|ISO/i.test(text);
const acknowledged = /sub-agent|subagent|子|instruction|you (said|asked)|per your|as you|user/i.test(text);
const ok = redirected && rt.children(manager.id).length === 2 && followed && acknowledged;
console.log(`model calls: ${rt.store.listTraces().length}, total ≈$${rt.ledger.globalUsd.toFixed(5)}`);
console.log(`redirected: ${redirected}; answer uses payment/certification: ${followed}; says it followed the user's change: ${acknowledged} → ${ok ? 'PASS' : 'FAIL'}`);
await rt.close();
await rm(root, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
