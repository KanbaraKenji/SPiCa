// The libraries the Agent's scripts can require (exceljs for .xlsx, papaparse for CSV), each bundled into a
// single CommonJS file with rolldown, into apps/desktop/node-libs/node_modules/<name>/ with its package.json
// (name, version, license) and licence text. electron-builder ships the folder as a resource (outside the
// asar, so any Node can read it); the backend puts it last on run_command's NODE_PATH (core runtimes.ts).
// Runs before dev, build and dist; skips work when the output is newer than the installed package.
//   node scripts/node-libs.mjs [outDir]
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const require = createRequire(join(appDir, 'package.json'));

/** The libraries, by npm name (also the name scripts require). Versions come from apps/desktop/package.json. */
export const NODE_LIBS = ['exceljs', 'papaparse'];

function packageDir(name) {
  return dirname(require.resolve(`${name}/package.json`));
}

function licenceFile(dir) {
  return readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
}

/** The npm packages a bundle's modules come from (each once), from their paths under node_modules. */
function bundledPackages(moduleIds) {
  const dirs = new Map();
  for (const id of moduleIds) {
    const m = /^(.*[\\/]node_modules[\\/])((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id.replace(/^\0/, ''));
    if (m) dirs.set(m[1] + m[2], true);
  }
  return [...dirs.keys()]
    .map((dir) => {
      const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const lic = licenceFile(dir);
      return { name: p.name, version: p.version, license: typeof p.license === 'string' ? p.license : JSON.stringify(p.license ?? 'UNKNOWN'), text: lic ? readFileSync(join(dir, lic), 'utf8') : '' };
    })
    .filter((p, i, all) => all.findIndex((q) => q.name === p.name && q.version === p.version) === i)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function thirdParty(pkgs) {
  return pkgs.map((p) => `${p.name} ${p.version} (${p.license})\n\n${p.text.trim() || '(no licence file in the package)'}\n`).join('\n' + '-'.repeat(72) + '\n\n');
}

/** Bundle every library into `outDir` (default apps/desktop/node-libs). Returns what was written. */
export async function buildNodeLibs(outDir = join(appDir, 'node-libs')) {
  const { rolldown } = await import(pathToFileURL(require.resolve('rolldown')).href);
  const written = [];
  for (const name of NODE_LIBS) {
    const src = packageDir(name);
    const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
    const dest = join(outDir, 'node_modules', name);
    const meta = join(dest, 'package.json');
    if (existsSync(meta) && JSON.parse(readFileSync(meta, 'utf8')).version === pkg.version && statSync(meta).mtimeMs >= statSync(join(src, 'package.json')).mtimeMs) {
      written.push({ name, version: pkg.version, skipped: true });
      continue;
    }
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    // the entry sits in apps/desktop, so `name` resolves to the installed package (with its own nested
    // dependencies), never to the output folder
    const entry = join(appDir, `.node-libs-${name}.cjs`);
    writeFileSync(entry, `module.exports = require(${JSON.stringify(name)});\n`);
    const bundle = await rolldown({ input: entry, platform: 'node', logLevel: 'silent' });
    const { output } = await bundle.write({ file: join(dest, 'index.js'), format: 'cjs', minify: true });
    await bundle.close();
    rmSync(entry);
    const lic = licenceFile(src);
    if (lic) copyFileSync(join(src, lic), join(dest, 'LICENSE'));
    // the bundle holds the library's dependencies too: their names, versions, licences and licence texts
    const bundled = bundledPackages(output.flatMap((o) => o.moduleIds ?? []));
    writeFileSync(join(dest, 'THIRD-PARTY.txt'), thirdParty(bundled));
    writeFileSync(meta, JSON.stringify({ name, version: pkg.version, license: pkg.license, main: 'index.js' }, null, 2) + '\n');
    written.push({ name, version: pkg.version, bytes: statSync(join(dest, 'index.js')).size, packages: bundled.map((p) => `${p.name}@${p.version} ${p.license}`) });
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? resolve(process.argv[2]) : undefined;
  for (const w of await buildNodeLibs(out)) console.log(`[node-libs] ${w.name} ${w.version}${w.skipped ? ' (up to date)' : ` ${Math.round(w.bytes / 1024)} KB`}`);
}
