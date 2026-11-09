// Runs stress-provider-stop.ts several times against one gateway process and prints exit codes.
// Usage (from packages/core): node scripts/diag/compare-provider-stop.mjs [runs] [rounds] [client-exe]
// client-exe defaults to this node; pass Electron's exe to test its bundled Node (ELECTRON_RUN_AS_NODE=1 is set).
import { spawn, spawnSync } from 'node:child_process';
const [runs = '8', rounds = '300', exe = process.execPath] = process.argv.slice(2);
const server = spawn(process.execPath, ['scripts/diag/gateway-proc.ts'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const url = await new Promise((r) => server.stdout.once('data', (d) => r(d.toString().trim())));
try {
  const out = [];
  for (let i = 0; i < Number(runs); i++) {
    const c = spawnSync(exe, ['scripts/diag/stress-provider-stop.ts', rounds], { env: { ...process.env, GW_URL: url, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 180000 });
    out.push(c.status === 0 ? 'ok' : `0x${(c.status >>> 0).toString(16)}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(out.join(' '));
} finally {
  server.kill();
}
