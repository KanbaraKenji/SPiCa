#!/usr/bin/env node
// Run the automated acceptance journeys one after another and write a summary.
//
//   npm run acceptance                    # all steps
//   npm run acceptance -- --only j6,shots # some steps (core, j6, shots)
//
// Steps:
//   core   J2 J3 J4 J5 J7 through Spica's MCP service, real model (needs .env.local)
//   j6     J6 plugins through the MCP service, real model (needs .env.local)
//   shots  J8 screenshot matrix (light/dark x window sizes x zoom), no model
// J1 (install and first start) is checked by hand.
//
// The summary is printed and saved to out/acceptance/summary-<time>.md (ignored by git).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = join(root, 'docs', 'screenshots', 'shell');
const hasEnv = existsSync(join(root, '.env.local'));

const STEPS = [
  { id: 'core', title: 'Core journeys (J2 J3 J4 J5 J7)', args: ['run', 'journeys', '-w', '@spica/core'], needsModel: true },
  { id: 'j6', title: 'Plugin journey (J6)', args: ['run', 'journey:j6', '-w', '@spica/plugins'], needsModel: true },
  { id: 'shots', title: 'Screenshot matrix (J8)', args: ['run', 'shots', '-w', '@spica/desktop'], needsModel: false },
];

function parseOnly(argv) {
  const i = argv.findIndex((a) => a === '--only' || a.startsWith('--only='));
  if (i < 0) return null;
  const raw = argv[i].includes('=') ? argv[i].slice('--only='.length) : (argv[i + 1] ?? '');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const only = parseOnly(process.argv.slice(2));
if (only) {
  const unknown = only.filter((id) => !STEPS.some((s) => s.id === id));
  if (unknown.length) {
    console.error(`Unknown step(s): ${unknown.join(', ')}. Known: ${STEPS.map((s) => s.id).join(', ')}`);
    process.exit(2);
  }
}
const steps = STEPS.filter((s) => !only || only.includes(s.id));

// Run npm through the current Node, so no shell and no console window is involved.
function npmCli() {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && /npm-cli\.c?js$/.test(fromEnv)) return fromEnv;
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(bundled)) return bundled;
  throw new Error('Cannot find npm-cli.js next to Node; run this through "npm run acceptance".');
}

function run(step) {
  return new Promise((done) => {
    const started = Date.now();
    const lines = [];
    let tail = '';
    const child = spawn(process.execPath, [npmCli(), ...step.args], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const onData = (stream) => (chunk) => {
      stream.write(chunk);
      const text = tail + chunk.toString('utf8');
      const parts = text.split(/\r?\n/);
      tail = parts.pop() ?? '';
      lines.push(...parts);
    };
    child.stdout.on('data', onData(process.stdout));
    child.stderr.on('data', onData(process.stderr));
    child.on('error', (err) => {
      lines.push(`spawn error: ${err.message}`);
    });
    child.on('close', (code) => {
      if (tail) lines.push(tail);
      done({ code: code ?? 1, lines, ms: Date.now() - started });
    });
  });
}

function newShots(since) {
  if (!existsSync(shotsDir)) return 0;
  return readdirSync(shotsDir).filter((f) => f.endsWith('.png') && statSync(join(shotsDir, f)).mtimeMs >= since).length;
}

const results = [];
for (const step of steps) {
  if (step.needsModel && !hasEnv) {
    results.push({ step, status: 'SKIP', detail: 'no .env.local (copy .env.example and fill in a model endpoint)', checks: [], ms: 0 });
    console.log(`\n== ${step.title}: skipped, no .env.local\n`);
    continue;
  }
  console.log(`\n== ${step.title}: npm ${step.args.join(' ')}\n`);
  const since = Date.now();
  const r = await run(step);
  // Journey scripts print either "PASS x / FAIL x" lines or "✓ x / ✗ x" lines
  // followed by one overall PASS/FAIL line; prefer the detailed ones.
  const ticks = r.lines.map((l) => l.trim()).filter((l) => /^[✓✗]/.test(l));
  const checks = ticks.length
    ? ticks.map((l) => (l.startsWith('✓') ? 'PASS' : 'FAIL') + ' ' + l.slice(1).trim())
    : r.lines.map((l) => l.trim()).filter((l) => /^(PASS|FAIL)\b/.test(l));
  const failed = checks.filter((l) => l.startsWith('FAIL'));
  let detail =
    step.id === 'shots'
      ? `${newShots(since)} screenshots written to docs/screenshots/shell/`
      : `${checks.length - failed.length}/${checks.length} checks passed`;
  if (r.code !== 0 && !failed.length) detail += `; exited with code ${r.code}`;
  results.push({ step, status: r.code === 0 && !failed.length ? 'PASS' : 'FAIL', detail, checks, ms: r.ms });
}

const stamp = new Date();
const pad = (n) => String(n).padStart(2, '0');
const id = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
const overall = results.some((r) => r.status === 'FAIL') ? 'FAIL' : results.some((r) => r.status === 'SKIP') ? 'INCOMPLETE' : 'PASS';

const md = [
  `# Acceptance summary ${stamp.toISOString()}`,
  '',
  `Overall: **${overall}**`,
  '',
  '| Step | Result | Detail | Time |',
  '| --- | --- | --- | --- |',
  ...results.map((r) => `| ${r.step.title} | ${r.status} | ${r.detail} | ${(r.ms / 1000).toFixed(0)} s |`),
  '',
  'J1 (install without admin rights, splash, first streamed reply) is checked by hand.',
  '',
  ...results
    .filter((r) => r.checks.length)
    .flatMap((r) => [`## ${r.step.title}`, '', ...r.checks.map((c) => `- ${c}`), '']),
].join('\n');

const outDir = join(root, 'out', 'acceptance');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `summary-${id}.md`);
writeFileSync(file, md + '\n');

console.log('\n' + md);
console.log(`\nSaved: ${file}`);
process.exit(overall === 'PASS' ? 0 : 1);
