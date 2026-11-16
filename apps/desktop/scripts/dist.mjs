// npm run dist: build, then package for Windows. A company's deploy.json
// (see deploy.mjs) renames the installer, shortcuts and app id here, with no
// change to any file under version control.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_APP, OFFICIAL_CHANNEL, readDeploy } from './deploy.mjs';

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

/** Where the packaged app will look for updates and official plugins, as the app decides it (src/main/update/channel.ts). */
export function sourceLines(deploy) {
  const official = deploy.app.id === DEFAULT_APP.id;
  const update = deploy.updateSource === null ? (official ? `official channel ${OFFICIAL_CHANNEL}` : 'none (not in deploy.json)') : (deploy.updateSources ?? []).join(' | ') || 'none';
  const plugins =
    deploy.pluginSources === null
      ? `official channel ${OFFICIAL_CHANNEL}index.json`
      : deploy.pluginSources.length
        ? deploy.pluginSources.map((s) => (s.mirrors ?? [s.location]).join(' | ')).join(', ')
        : 'none';
  return [`updates: ${update}`, `official plugins: ${plugins}`];
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
  for (const line of sourceLines(deploy)) console.log(`[dist] ${line}`);
  run(join(dirname(fileURLToPath(import.meta.url)), 'node-libs.mjs'), []);
  run(join(packageDir('electron-vite'), 'bin', 'electron-vite.js'), ['build']);
  run(join(packageDir('electron-builder'), 'cli.js'), ['--win', '--publish', 'never', ...extra]);
}
