// Lists the interface's words still written straight into the desktop app's code (not through t()), per file:
//   node scripts/i18n/left.mjs            counts per file
//   node scripts/i18n/left.mjs <file>...  every such line of those files
//   node scripts/i18n/left.mjs --pending  writes apps/desktop/src/shared/i18n/pending.txt from what is left
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanSource } from '../../apps/desktop/src/shared/i18n/scan.ts';

const DESKTOP = join(import.meta.dirname, '..', '..', 'apps', 'desktop', 'src');
const SKIP_FILE = /(^|\/)(fake-seed|fake|fake-mail|shots)\.ts$|(^|\/)shared\/i18n\/|(^|\/)testing\//;
const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [p] : [];
  });
const slash = (p) => p.split('\\').join('/');
const rel = (p) => slash(relative(DESKTOP, p));
const args = process.argv.slice(2);
const all = ['renderer', 'main', 'shared', 'backend']
  .flatMap((d) => files(join(DESKTOP, d)))
  .map((p) => ({ path: rel(p), left: scanSource(readFileSync(p, 'utf8')).filter((f) => !f.key) }))
  .filter((s) => !SKIP_FILE.test(s.path) && s.left.length);
if (args[0] === '--pending') {
  writeFileSync(join(DESKTOP, 'shared', 'i18n', 'pending.txt'), `# Files whose words are not moved into t() yet (i18n.test.ts). The list only shrinks.\n${all.map((s) => s.path).join('\n')}\n`);
  console.log(`${all.length} files`);
} else if (args.length) {
  for (const s of all.filter((s) => args.some((a) => s.path.endsWith(slash(a)))))
    for (const f of s.left) console.log(`${s.path}:${f.line} ${f.text.replace(/\n/g, '⏎')}`);
} else {
  for (const s of all.sort((a, b) => b.left.length - a.left.length)) console.log(`${String(s.left.length).padStart(4)} ${s.path}`);
  console.log(`${all.reduce((n, s) => n + s.left.length, 0)} in ${all.length} files`);
}
