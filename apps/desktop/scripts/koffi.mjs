// koffi (MIT), which 操作电脑 calls Windows with (src/main/computer/win32.ts), as the installed app carries it:
// the few files of the koffi package it loads and its Windows x64 native part, copied from node_modules into
// apps/desktop/koffi/ (not in the repository); electron-builder ships that folder as resources/koffi. koffi is not
// bundled into the main process (it requires each platform's native package by name, and a .node file cannot be
// bundled): the app loads it from resources/koffi when that is there, else from node_modules (a development run).
// Runs before dev, preview, build and dist.
//   node scripts/koffi.mjs [outDir]
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(appDir, 'package.json'));

/** The files of koffi itself that loading it reads (index.cjs and what it requires). */
export const KOFFI_FILES = ['package.json', 'index.cjs', 'index.d.ts', 'LICENSE.txt', 'src/koffi/index.cjs', 'src/koffi/src/static.cjs'];
/** The native package for the platforms the installer is made for (electron-builder.yml: Windows x64). */
export const NATIVE = { name: '@koromix/koffi-win32-x64', files: ['package.json', 'index.js', 'win32_x64/koffi.node'] };

export function copyKoffi(outDir = join(appDir, 'koffi')) {
  // the packages' main files (their exports do not list package.json)
  const from = dirname(require.resolve('koffi'));
  const nativeFrom = dirname(createRequire(join(from, 'index.cjs')).resolve(NATIVE.name));
  const version = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')).version;
  rmSync(outDir, { recursive: true, force: true });
  const copy = (src, dest) => {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  };
  for (const f of KOFFI_FILES) copy(join(from, f), join(outDir, f));
  for (const f of NATIVE.files) copy(join(nativeFrom, f), join(outDir, 'node_modules', NATIVE.name, f));
  return { version, outDir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = copyKoffi(process.argv[2] ? resolve(process.argv[2]) : undefined);
    console.log(`[koffi] ${r.version} → ${r.outDir}`);
  } catch (err) {
    // without it the app runs as before; only 操作电脑 says it cannot start (win32.ts)
    console.warn(`[koffi] not copied: ${err instanceof Error ? err.message : String(err)}`);
  }
}
