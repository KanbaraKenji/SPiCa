// Real-model smoke test: one conversation where the model reads a file,
// greps once, then answers. Prints an event summary and the traceable records.
//
//   npm run smoke:deepseek      (OpenAI-compatible endpoint from .env.local)
//   npm run smoke:claude        (Anthropic, Haiku by default)
//
// Keys and endpoints are read from the environment (loaded with --env-file);
// nothing secret is printed: trace targets are masked in this output.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicProvider } from '../src/providers/anthropic.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai.ts';
import type { Provider } from '../src/providers/types.ts';
import { Runtime } from '../src/runtime.ts';
import type { CoreEvent } from '../src/types.ts';

const which = process.argv[2] ?? 'deepseek';
const env = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`missing ${name} (expected in .env.local)`);
    process.exit(2);
  }
  return v;
};

let provider: Provider;
let model: string;
if (which === 'claude') {
  model = process.env.SPICA_ANTHROPIC_MODEL ?? 'claude-haiku-5-5';
  provider = new AnthropicProvider({ id: 'anthropic', apiKey: env('SPICA_ANTHROPIC_API_KEY') });
} else {
  model = process.env.SPICA_OPENAI_MODEL ?? 'deepseek-flash';
  provider = new OpenAICompatibleProvider({
    id: 'openai',
    baseUrl: env('SPICA_OPENAI_BASE_URL'),
    apiKey: env('SPICA_OPENAI_API_KEY'),
  });
}

const dir = await mkdtemp(join(tmpdir(), 'spica-smoke-'));
await writeFile(
  join(dir, 'notes.txt'),
  ['Project: Orion relaunch', 'Launch code: 4471-ZETA', 'Owner: Mika Tanaka', 'Status: waiting for sign-off', ''].join('\n'),
);
await writeFile(join(dir, 'other.md'), '# Other\nOwner: nobody (decoy file)\n');

const rt = new Runtime({
  providers: [provider],
  defaults: { providerId: provider.id, model, maxTokens: 1024, maxTurns: 8 },
  cwd: dir,
  // Dev configuration from the brief: Anthropic global 100 USD, 2 USD per call.
  budget: { perProvider: { anthropic: { globalUsd: 100, perCallUsd: 2 } }, perRunUsd: 1 },
  limits: { [provider.id]: { maxConcurrent: 2, requestsPerMinute: 30 } },
});

const summary: string[] = [];
let text = '';
const t0 = Date.now();
const stamp = () => `${String(Date.now() - t0).padStart(6)}ms`;
rt.events.on((e: CoreEvent) => {
  switch (e.type) {
    case 'status':
      summary.push(`${stamp()} status   ${e.status}${e.detail ? ` (${e.detail})` : ''}`);
      break;
    case 'text.delta':
      text += e.delta;
      break;
    case 'tool.start':
      if (text) summary.push(`${stamp()} text     ${JSON.stringify(text.slice(0, 120))}`);
      text = '';
      summary.push(`${stamp()} tool ▶   ${e.name} ${JSON.stringify(e.input)}`);
      break;
    case 'tool.end':
      summary.push(`${stamp()} tool ■   ${e.name} ${e.isError ? 'ERROR' : 'ok'} ${e.durationMs}ms  ${JSON.stringify(e.preview.split('\n').slice(0, 2).join(' | ').slice(0, 100))}`);
      break;
    case 'usage':
      summary.push(`${stamp()} usage    in=${e.usage.inputTokens} out=${e.usage.outputTokens}${e.usage.cacheReadTokens ? ` cacheRead=${e.usage.cacheReadTokens}` : ''} ≈$${e.costUsd.toFixed(5)}`);
      break;
    case 'error':
      summary.push(`${stamp()} error    ${e.message}`);
      break;
    case 'budget.stop':
      summary.push(`${stamp()} budget   ${e.message}`);
      break;
    case 'run.end':
      if (text) summary.push(`${stamp()} text     ${JSON.stringify(text.slice(0, 300))}`);
      text = '';
      summary.push(`${stamp()} run.end  ${e.reason}${e.detail ? ` (${e.detail})` : ''}`);
      break;
    default:
      break;
  }
});

const session = rt.createSession({ title: `smoke ${which}` });
const result = await session.send(
  'In the working folder there is a file notes.txt. First read it with read_file. ' +
    'Then run grep once for the pattern "Owner" across the folder. ' +
    'Then answer in one sentence: what is the launch code, and which file(s) mention an owner?',
).done;

console.log(`\n== Spica core smoke: ${which} (${provider.kind}, model ${model}) ==`);
console.log(summary.join('\n'));
console.log(`\nfinal answer: ${result.text}`);
console.log(`\n== traceable records (${rt.store.listTraces().length}) ==`);
for (const t of rt.store.listTraces()) {
  console.log(JSON.stringify({ ...t, target: '[masked]' }));
}
const tools = session
  .messages()
  .flatMap((m) => m.content)
  .flatMap((b) => (b.type === 'tool_use' ? [b.name] : []));
const ok = result.reason === 'completed' && tools.includes('read_file') && tools.includes('grep') && /4471-ZETA/.test(result.text);
console.log(`\ntools used: ${tools.join(', ')}  total ≈$${rt.ledger.globalUsd.toFixed(5)}  → ${ok ? 'PASS' : 'FAIL'}`);
await rm(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
