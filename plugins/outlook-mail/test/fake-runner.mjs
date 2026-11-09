// Runs requests through outlook.ps1 against the fake Outlook (test/fake-outlook.ps1).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { powershellPath } from '../server/outlook-backend.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export function runFake(requests) {
  const r = spawnSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', here('./run-fake.ps1')], {
    input: JSON.stringify(requests),
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, SPICA_OUTLOOK_SCRIPT: here('../server/outlook.ps1'), SPICA_FAKE_SCRIPT: here('./fake-outlook.ps1') },
  });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`fake run failed (exit ${r.status}): ${r.stdout.slice(0, 500)} ${r.stderr.slice(0, 2000)}`);
  }
}
