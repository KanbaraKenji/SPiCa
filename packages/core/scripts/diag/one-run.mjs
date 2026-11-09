import { spawn, spawnSync } from 'node:child_process';
const exe = process.argv[2];
const server = spawn(process.execPath, ['scripts/diag/gateway-proc.ts'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const url = await new Promise((r) => server.stdout.once('data', (d) => r(d.toString().trim())));
try {
  const c = spawnSync(exe, ['scripts/diag/stress-provider-stop.ts', process.argv[3] ?? '100'], { env: { ...process.env, GW_URL: url, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  console.log('status', c.status, c.stdout.trim().split('\n').slice(-1)[0]);
  console.log(c.stderr.split('\n').filter((l) => !/^\s+at /.test(l)).slice(0, 12).join('\n'));
} finally { server.kill(); }
