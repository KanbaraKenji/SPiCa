import { spawn, spawnSync } from 'node:child_process';
const server = spawn(process.execPath, ['scripts/diag/gateway-proc.ts'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const url = await new Promise((r) => server.stdout.once('data', (d) => r(d.toString().trim())));
const exe = process.argv[2] ?? process.execPath;
const run = (args) => { const c = spawnSync(exe, args, { env: { ...process.env, GW_URL: url, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 120000 }); return c.status === 0 ? 'ok' : `0x${(c.status >>> 0).toString(16)}`; };
try {
  const f = [], h = [];
  for (let i = 0; i < 8; i++) { f.push(run(['scripts/diag/abort-min.mjs', 'abort', '300'])); h.push(run(['scripts/diag/http-min.mjs', '300'])); await new Promise((r) => setTimeout(r, 1500)); }
  console.log('fetch', f.join(' '));
  console.log('http ', h.join(' '));
} finally { server.kill(); }
