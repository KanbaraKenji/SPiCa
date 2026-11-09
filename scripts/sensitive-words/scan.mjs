#!/usr/bin/env node
// Scan repository files for sensitive words. Exits 1 on any hit.
//
// Word lists:
//   - scripts/sensitive-words/words.example.txt is always used (generic examples).
//   - Extra lists come from --words <path> (repeatable) and/or the
//     SPICA_SENSITIVE_WORDS environment variable (paths joined by ';' on
//     Windows, ':' elsewhere). A private repository injects its list this way.
//
// Files: tracked plus untracked-but-not-ignored files (git ls-files).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLists, scanFiles } from './scanner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const exampleList = join(here, 'words.example.txt');

function parseArgs(argv) {
  const lists = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--words' && argv[i + 1]) lists.push(argv[++i]);
    else if (argv[i]?.startsWith('--words=')) lists.push(argv[i].slice('--words='.length));
  }
  return lists;
}

const injected = [
  ...parseArgs(process.argv.slice(2)),
  ...(process.env.SPICA_SENSITIVE_WORDS ?? '').split(delimiter).filter(Boolean),
].map((p) => resolve(p));

for (const p of injected) {
  if (!existsSync(p)) {
    console.error(`Sensitive-word list not found: ${p}`);
    process.exit(2);
  }
}

const listPaths = [exampleList, ...injected];
const entries = loadLists(listPaths);

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
})
  .split('\0')
  .filter(Boolean);

const hits = scanFiles({ root, files, listPaths, entries });
const inActions = process.env.GITHUB_ACTIONS === 'true';

for (const h of hits) {
  // Never print the word itself; point at the list entry instead.
  const msg = `sensitive word (${h.list} line ${h.entryLine})`;
  if (inActions) console.log(`::error file=${h.file},line=${h.line}::${msg}`);
  console.log(`${h.file}:${h.line}: ${msg}`);
}

console.log(
  `Sensitive-word scan: ${files.length} files, ${entries.length} words from ${listPaths.length} list(s), ${hits.length} hit(s).`,
);
process.exit(hits.length > 0 ? 1 : 0);
