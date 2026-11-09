// Evaluation run: J2–J7 through Spica's MCP service, Markdown report.
//
// Start a fresh Spica (stdio, new database in a temp folder), DeepSeek from .env.local:
//   npm run eval -w @spica/plugin-example-eval -- [--only J2,J5] [--out report.md] [--log usage.jsonl]
// Evaluate a Spica that is already running with MCP over HTTP (J2–J4 and J7 are skipped):
//   node src/run.ts --url http://127.0.0.1:<port>/mcp --token-env SPICA_MCP_TOKEN
//
// --log also exports the usage log of the evaluated Spica (JSON Lines, redacted).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoNow, redact } from '@spica/core';
import { makeDocx, makeInventoryXlsx, makePdf } from '@spica/extract/src/testing/fixtures.ts';
import { evaluate } from './evaluate.ts';
import { JOURNEYS, type JourneyContext } from './journeys.ts';
import { httpLink, startStdioLink } from './link.ts';
import { renderReport } from './report.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = opt('only')?.split(',').map((s) => s.trim().toUpperCase());
const out = opt('out');
const logOut = opt('log');
const url = opt('url');
const startedAt = isoNow();
const secrets: string[] = [];
const examplePlugin = fileURLToPath(new URL('../../example-notes', import.meta.url));

let ctx: JourneyContext;
let mode: string;
let model: string;
let cleanup = async () => {};

if (url) {
  const tokenEnv = opt('token-env') ?? 'SPICA_MCP_TOKEN';
  const token = process.env[tokenEnv];
  if (!token) {
    console.error(`missing the bearer token in ${tokenEnv}`);
    process.exit(2);
  }
  secrets.push(token);
  ctx = { link: httpLink(url, token), examplePlugin };
  mode = 'HTTP（连到已在运行的 Spica）';
  model = '由被测的 Spica 决定';
} else {
  const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
  const apiKey = process.env.SPICA_OPENAI_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error('missing SPICA_OPENAI_BASE_URL / SPICA_OPENAI_API_KEY (run with --env-file=.env.local)');
    process.exit(2);
  }
  secrets.push(apiKey, baseUrl, new URL(baseUrl).host);
  const modelName = process.env.SPICA_OPENAI_MODEL ?? 'deepseek-flash';
  model = `deepseek / ${modelName}`;
  mode = 'stdio（新起一个 Spica，临时数据库）';
  const root = await mkdtemp(join(tmpdir(), 'spica-eval-'));
  cleanup = () => rm(root, { recursive: true, force: true }).catch(() => undefined);
  // sample files the journeys ask about
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'quote.pdf'), await makePdf([['Quotation Q-2026-117', 'Unit price: 12.40 EUR per piece', 'Valid until 2026-12-31']]));
  await writeFile(join(root, 'docs', 'spec.docx'), await makeDocx({ title: 'Product spec', sections: [{ heading: 'Battery', paragraphs: ['Capacity: 4800 mAh'] }] }));
  await writeFile(join(root, 'docs', 'inventory.xlsx'), await makeInventoryXlsx());
  await mkdir(join(root, 'suppliers'), { recursive: true });
  await writeFile(join(root, 'suppliers', 'supplier-a.md'), '# Supplier A offer\nUnit price: 12.40 EUR\nLead time: 6 weeks\nPayment: 30 days net\nCertified: ISO 9001\n');
  await writeFile(join(root, 'suppliers', 'supplier-b.md'), '# Supplier B offer\nUnit price: 11.10 EUR\nLead time: 10 weeks\nPayment: prepayment 50%\nCertified: none\n');
  // Spica's own MCP service entry and example workflows, found next to the core package
  const coreSrc = dirname(fileURLToPath(import.meta.resolve('@spica/core')));
  const entry = join(coreSrc, 'host', 'mcp-main.ts');
  const config = join(root, 'backend.json'); // removed with the temp folder
  await writeFile(
    config,
    JSON.stringify({
      dbPath: join(root, 'data', 'spica.db'),
      providers: [{ id: 'deepseek', kind: 'openai-compatible', baseUrl, apiKeyEnv: 'SPICA_OPENAI_API_KEY', limits: { maxConcurrent: 3 } }],
      defaults: { providerId: 'deepseek', model: modelName, maxTokens: 1500, maxTurns: 12 },
      cwd: root,
      projectsRoot: root,
      workflowsDir: join(coreSrc, '..', 'examples', 'workflows'),
      extractorModules: ['@spica/extract'],
      extensions: [{ module: '@spica/plugins', options: { root: join(root, 'plugins') } }],
      budget: { perRunUsd: 0.5 },
    }),
  );
  const start = () => startStdioLink({ entry, config, env: { SPICA_OPENAI_API_KEY: apiKey } });
  ctx = { link: await start(), examplePlugin };
  ctx.restart = async () => {
    await ctx.link.close();
    return start();
  };
}

let failed = true;
try {
  console.log(`Spica 评测：${mode}`);
  const { results, totals } = await evaluate(ctx, JOURNEYS, {
    ...(only ? { only } : {}),
    localFixtures: !url,
    onResult: (r) => console.log(`${r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP'} ${r.id} ${r.title}: ${r.note.slice(0, 200)}`),
  });
  const report = redact(renderReport({ startedAt, mode, model, results, journeyTotals: totals }), secrets);
  if (out) {
    await writeFile(out, report);
    console.log(`\n报告已写到 ${out}`);
  } else {
    console.log(`\n${report}`);
  }
  if (logOut) {
    const log = await ctx.link.text('spica_export_usage_log');
    await writeFile(logOut, `${redact(log, secrets)}\n`);
    console.log(`使用日志已导出到 ${logOut}（${log.split('\n').length} 行）`);
  }
  failed = results.some((r) => r.status === 'fail') || results.length === 0;
  console.log(failed ? 'SOME FAILED' : 'ALL PASS');
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
} finally {
  await ctx.link.close();
  await cleanup();
}
process.exit(failed ? 1 : 0);

