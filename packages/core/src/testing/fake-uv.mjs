// The stand-in for uv as a real program (python-env.test.ts, the tests that check what reaches a child process):
//   node fake-uv.mjs <config.json> <uv arguments>
// What it does is fake-uv-run.mjs; most tests run that in their own process instead (PythonEnvOptions.runUv).
import { readFileSync } from 'node:fs';
import { runFakeUv } from './fake-uv-run.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const args = process.argv.slice(3);
const input = args[0] === 'pip' && args[1] === 'compile' ? readFileSync(0, 'utf8') : '';
const r = runFakeUv({ config, args, env: process.env, input });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exitCode = r.code;
