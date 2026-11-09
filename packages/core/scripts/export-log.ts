// Export the usage log of a Spica database as JSON Lines.
//
//   node scripts/export-log.ts --db <spica.db> [--project <id>] [--from <ISO>] [--to <ISO>]
//                              [--config <backend.json>] [--out <file.jsonl>]
//
// Opens the database read-only, so it also works while the app is running.
// Redacted: key-looking strings, every provider key / client secret /
// endpoint address in --config, and the values of environment variables whose
// names say key / secret / token / password / URL (run with --env-file=… to have
// the deployment's keys and endpoints removed too; model names stay).
import { readFileSync, writeFileSync } from 'node:fs';
import { exportUsageLog } from '../src/export.ts';
import type { BackendConfig } from '../src/host/backend.ts';
import { SqliteStore } from '../src/store/sqlite.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const db = opt('db');
if (!db) {
  process.stderr.write('usage: export-log --db <spica.db> [--project <id>] [--from <ISO>] [--to <ISO>] [--config <backend.json>] [--out <file>]\n');
  process.exit(2);
}

const secrets = new Set<string>();
const addUrl = (u: string | undefined) => {
  if (!u) return;
  secrets.add(u);
  try {
    secrets.add(new URL(u).host);
  } catch {
    // not a URL
  }
};
/** Names whose values are credentials or endpoints (not "every SPICA_ variable": model names must survive). */
const SECRET_VALUE_NAME = /(API_?KEY|SECRET|TOKEN|PASSW(OR)?D|CREDENTIAL|PRIVATE_?KEY|BASE_?URL|ENDPOINT)/i;
for (const [name, value] of Object.entries(process.env)) {
  if (!value || value.length < 8 || !SECRET_VALUE_NAME.test(name)) continue;
  secrets.add(value);
  if (/^https?:\/\//i.test(value)) addUrl(value);
}
const cfgPath = opt('config');
if (cfgPath) {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as BackendConfig;
  for (const p of cfg.providers) {
    if (p.apiKey) secrets.add(p.apiKey);
    if (p.apiKeyEnv && process.env[p.apiKeyEnv]) secrets.add(process.env[p.apiKeyEnv]!);
    addUrl(p.baseUrl);
    if (p.oauth) {
      secrets.add(p.oauth.clientSecret);
      secrets.add(p.oauth.clientId);
      addUrl(p.oauth.tokenUrl);
    }
  }
}

const store = new SqliteStore(db, { readOnly: true });
try {
  const jsonl = exportUsageLog(
    store,
    {
      ...(opt('project') ? { projectId: opt('project')! } : {}),
      ...(opt('from') ? { from: opt('from')! } : {}),
      ...(opt('to') ? { to: opt('to')! } : {}),
    },
    { secrets: [...secrets] },
  );
  const out = opt('out');
  if (out) {
    writeFileSync(out, `${jsonl}\n`);
    process.stderr.write(`[spica] ${jsonl.split('\n').length} lines written to ${out}\n`);
  } else {
    process.stdout.write(`${jsonl}\n`);
  }
} finally {
  store.close();
}
