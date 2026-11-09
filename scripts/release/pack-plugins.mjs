#!/usr/bin/env node
// Pack every official plugin under plugins/ into a zip for a release.
//
//   npm run pack:plugins                 # into out/plugins/
//   npm run pack:plugins -- --out <dir>
//
// For each folder in plugins/ that has a manifest.json (except templates listed
// in NOT_SHIPPED), writes:
//   <name>-<version>.zip          the plugin package (@spica/plugins packPlugin)
//   <name>-<version>.zip.sha256   "<sha256>  <file name>", checkable with sha256sum -c
// and then index.json for the whole folder. Uploaded next to each other (for
// example as GitHub Release assets), the index.json URL works as an HTTP plugin
// source in Settings › Plugins: Spica lists the plugins and checks every checksum.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPlugin, writeIndex } from '@spica/plugins';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const outDir = resolve(root, outArg >= 0 && args[outArg + 1] ? args[outArg + 1] : 'out/plugins');

// Folders kept in the repository as templates for developers but not shipped:
// installed from a zip they would do nothing.
const NOT_SHIPPED = new Set(['example-eval']);

const pluginsDir = join(root, 'plugins');
const all = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(pluginsDir, e.name, 'manifest.json')))
  .map((e) => e.name)
  .sort();
const folders = all.filter((f) => !NOT_SHIPPED.has(f));
for (const f of all.filter((f) => NOT_SHIPPED.has(f))) console.log(`${f}: template, not shipped`);
if (folders.length === 0) {
  console.error('pack:plugins: no plugin folders with a manifest.json under plugins/.');
  process.exit(1);
}

// Start from an empty output folder so stale versions never end up in the index.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const folder of folders) {
  const r = await packPlugin(join(pluginsDir, folder), outDir);
  const name = basename(r.file);
  writeFileSync(`${r.file}.sha256`, `${r.sha256}  ${name}\n`);
  console.log(`${folder} -> ${name} (${r.files} files, sha256 ${r.sha256})`);
}

const idx = await writeIndex(outDir);
if (idx.plugins.length !== folders.length) {
  console.error(`pack:plugins: index.json lists ${idx.plugins.length} of ${folders.length} packages; a package failed verification.`);
  process.exit(1);
}
console.log(`index.json: ${idx.plugins.map((p) => `${p.name} ${p.version}`).join(', ')}`);
console.log(`Written to ${outDir}`);
