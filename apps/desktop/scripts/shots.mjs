// Builds the app and renders the J8 screenshot matrix into docs/screenshots/shell/.
//   npm run shots -w @spica/desktop                 # default view
//   npm run shots -w @spica/desktop -- settings     # extra views, comma-separated
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const outDir = resolve(appDir, '../../docs/screenshots/shell');
const views = ['main', ...process.argv.slice(2).flatMap((a) => a.split(','))].filter((v, i, a) => v && a.indexOf(v) === i);

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
child.on('exit', (code) => process.exit(code ?? 1));
