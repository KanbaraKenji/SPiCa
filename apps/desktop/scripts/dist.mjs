// npm run dist: build, then package for Windows. A company's deploy.json
// (see deploy.mjs) renames the installer, shortcuts and app id here, with no
// change to any file under version control.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_APP, readDeploy } from './deploy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

/** electron-builder overrides for the name and id in deploy.json; none for plain Spica. */
export function builderOverrides(app, version) {
  const out = [];
  if (app.name !== DEFAULT_APP.name || app.id !== DEFAULT_APP.id) {
    out.push(
      `-c.appId=${app.id}`,
      `-c.productName=${app.name}`,
      `-c.nsis.shortcutName=${app.name}`,
      `-c.nsis.artifactName=${app.name}-Setup-${version}.\${ext}`,
      `-c.portable.artifactName=${app.name}-Portable-${version}.\${ext}`,
    );
  }
  if (app.icon) out.push(`-c.win.icon=${app.icon}`);
  return out;
}

/** A tool's own folder (its entry may live deeper; its bin is not always exported). */
function packageDir(name) {
  let dir = dirname(require.resolve(name));
  while (basename(dir) !== name.split('/').pop()) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`找不到 ${name}`);
    dir = up;
  }
  return dir;
}

function run(cmd, args) {
  const r = spawnSync(process.execPath, [cmd, ...args], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let deploy;
  try {
    deploy = readDeploy(root);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const extra = builderOverrides(deploy.app, version);
  console.log(`[dist] ${deploy.app.name} (${deploy.app.id})${deploy.file ? ' from deploy.json' : ''}`);
  run(join(packageDir('electron-vite'), 'bin', 'electron-vite.js'), ['build']);
  run(join(packageDir('electron-builder'), 'cli.js'), ['--win', '--publish', 'never', ...extra]);
}
