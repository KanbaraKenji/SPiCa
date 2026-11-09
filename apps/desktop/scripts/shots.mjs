// Builds the app and renders the J8 screenshot matrix into docs/screenshots/shell/.
//   npm run shots -w @spica/desktop                 # all views
//   npm run shots -w @spica/desktop -- main         # only some views, comma-separated
//   npm run shots -w @spica/desktop -- --out out/shots   # write elsewhere (also SPICA_SHOTS_OUT);
//                                                          relative to the repository root. The
//                                                          default, docs/screenshots/shell, is the
//                                                          committed baseline: only write it on purpose.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repoRoot = resolve(appDir, '../..');
const args = process.argv.slice(2);
const outAt = args.findIndex((a) => a === '--out' || a.startsWith('--out='));
let outArg = process.env.SPICA_SHOTS_OUT || '';
if (outAt >= 0) {
  const a = args[outAt];
  outArg = a.startsWith('--out=') ? a.slice(6) : (args[outAt + 1] ?? '');
  args.splice(outAt, a.startsWith('--out=') ? 1 : 2);
  if (!outArg) {
    console.error('--out needs a folder');
    process.exit(2);
  }
}
const outDir = resolve(repoRoot, outArg || 'docs/screenshots/shell');
// Default: conversation, settings > appearance, settings > models. Pass names to pick some.
const picked = args.flatMap((a) => a.split(',')).filter(Boolean);
const views = (picked.length ? picked : ['main', 'settings', 'models']).filter((v, i, a) => a.indexOf(v) === i);

const require = createRequire(import.meta.url);
const viteBin = join(dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js');
const build = spawnSync(process.execPath, [viteBin, 'build'], { cwd: appDir, stdio: 'inherit', windowsHide: true });
if (build.status !== 0) process.exit(build.status ?? 1);

const electron = require('electron');
const child = spawn(electron, ['.'], {
  cwd: appDir,
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, SPICA_SHOTS: outDir, SPICA_SHOTS_VIEWS: views.join(','), ELECTRON_RENDERER_URL: '' },
});
child.on('exit', (code) => {
  if (code === 0) console.log(`screenshots in ${outDir}`);
  process.exit(code ?? 1);
});
