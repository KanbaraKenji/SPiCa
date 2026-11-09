#!/usr/bin/env node
// Prepare a release locally: set the version, commit it and create the tag.
// Pushing is a separate, deliberate step.
//
//   npm run release:prepare -- 0.2.0        # exact version
//   npm run release:prepare -- patch        # or patch / minor / major
//   npm run release:prepare -- 0.2.0 --dry-run
//
// What it changes: "version" in the root package.json and apps/desktop/package.json
// (the app reads its version from the latter) and the matching package-lock.json
// entries. Then: git commit "Release vX.Y.Z" with only those files, and an
// annotated tag vX.Y.Z. Pushing the tag (git push origin main vX.Y.Z) starts
// .github/workflows/release.yml, which builds the installers.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = ['package.json', 'apps/desktop/package.json', 'package-lock.json'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const wanted = args.find((a) => !a.startsWith('--'));

function fail(msg) {
  console.error(`release:prepare: ${msg}`);
  process.exit(1);
}

function git(...a) {
  return execFileSync('git', a, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

if (!wanted) fail('give a version (for example 0.2.0) or patch / minor / major.');

const current = readJson('apps/desktop/package.json').version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!m) fail(`current version "${current}" is not x.y.z.`);
const [maj, min, pat] = m.slice(1).map(Number);
const next =
  wanted === 'major'
    ? `${maj + 1}.0.0`
    : wanted === 'minor'
      ? `${maj}.${min + 1}.0`
      : wanted === 'patch'
        ? `${maj}.${min}.${pat + 1}`
        : wanted.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) fail(`"${wanted}" is not a version like 0.2.0.`);
if (next === current) fail(`version is already ${current}.`);

const tag = `v${next}`;
if (git('tag', '--list', tag)) fail(`tag ${tag} already exists.`);

// Other people may have work in progress in the same tree; only the files this
// script touches must be clean, and only they go into the release commit.
const dirty = git('status', '--porcelain', '--', ...FILES);
if (dirty) fail(`commit or stash these first:\n${dirty}`);
const staged = git('diff', '--cached', '--name-only');
if (staged) fail(`something is already staged; commit or unstage it first:\n${staged}`);

console.log(`Version ${current} -> ${next}, tag ${tag}${dryRun ? ' (dry run, nothing changed)' : ''}`);
if (dryRun) process.exit(0);

// Edit the JSON files directly (keeps formatting: 2-space indent, final newline).
function setVersion(rel, edit) {
  const file = join(root, rel);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  edit(data);
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
setVersion('package.json', (p) => {
  p.version = next;
});
setVersion('apps/desktop/package.json', (p) => {
  p.version = next;
});
setVersion('package-lock.json', (lock) => {
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  if (lock.packages?.['apps/desktop']) lock.packages['apps/desktop'].version = next;
});

const tmp = mkdtempSync(join(tmpdir(), 'spica-release-'));
try {
  const msgFile = join(tmp, 'message.txt');
  writeFileSync(msgFile, `Release ${tag}\n`);
  git('add', '--', ...FILES);
  git('commit', '-F', msgFile);
  git('tag', '-a', tag, '-m', `Spica ${tag}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`Committed and tagged ${tag}. To publish: git push origin main ${tag}`);
