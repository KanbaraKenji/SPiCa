#!/usr/bin/env node
// The files for the official channel (the GitHub release tagged "channel", whose download
// address the app has built in; see docs/design/desktop-shell.md section 9):
//
//   latest.yml   electron-builder's own, with the installer named by its full address on the
//                release that holds it (path, and url under files)
//   index.json   the official plugins' index, each package by its full address on its release
//   channel.json {} — only with --channel-json: the first time; afterwards it is edited by hand
//                ("required", "movedTo") and never overwritten by a release
//
//   npm run release:channel -- --repo owner/name --tag v0.2.0 [--release apps/desktop/release]
//                              [--plugins out/plugins] [--plugins-tag <tag>] [--out out/channel]
//                              [--no-app] [--channel-json]
//
// --no-app: a plugin-only release (tags plugins-*): only index.json is written.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The download address of a file on a release. */
export function assetUrl(repo, tag, name) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/** latest.yml with every installer file name (path, url under files) made a full address on that release. */
export function channelLatestYml(text, repo, tag) {
  let changed = 0;
  const out = text.replace(/^(\s*(?:-\s+)?(?:path|url):\s*)(['"]?)([^'"\r\n]+?)\2(\s*)$/gm, (_m, head, _q, name, tail) => {
    if (/^https?:\/\//i.test(name)) throw new Error(`latest.yml already has a full address: ${name}`);
    if (/[\\/]|\.\./.test(name)) throw new Error(`latest.yml names a file outside its folder: ${name}`);
    changed++;
    return `${head}${assetUrl(repo, tag, name)}${tail}`;
  });
  if (!/^path:/m.test(text) || !/^version:/m.test(text)) throw new Error('latest.yml has no version or path.');
  return { text: out, changed };
}

/** index.json with every package's file made a full address on the release that holds it. */
export function channelIndex(index, repo, tag) {
  if (!index || index.index_version !== 1 || !Array.isArray(index.plugins)) throw new Error('index.json is not a plugin index (index_version 1).');
  return {
    ...index,
    plugins: index.plugins.map((p) => {
      if (typeof p.file !== 'string' || /[\\/]|\.\./.test(p.file)) throw new Error(`index.json names a package outside its folder: ${p.file}`);
      if (!p.sha256) throw new Error(`index.json has no SHA-256 for ${p.file}.`);
      return { ...p, file: assetUrl(repo, tag, p.file) };
    }),
  };
}

function args(argv) {
  const o = { release: 'apps/desktop/release', plugins: 'out/plugins', out: 'out/channel', app: true, channelJson: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value.`);
      return v;
    };
    if (a === '--repo') o.repo = next();
    else if (a === '--tag') o.tag = next();
    else if (a === '--plugins-tag') o.pluginsTag = next();
    else if (a === '--release') o.release = next();
    else if (a === '--plugins') o.plugins = next();
    else if (a === '--out') o.out = next();
    else if (a === '--no-app') o.app = false;
    else if (a === '--channel-json') o.channelJson = true;
    else throw new Error(`Unknown option ${a}.`);
  }
  if (!o.repo || !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error('--repo owner/name is needed.');
  if (!o.tag) throw new Error('--tag is needed.');
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = args(process.argv.slice(2));
    const out = resolve(root, o.out);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    if (o.app) {
      const yml = join(resolve(root, o.release), 'latest.yml');
      if (!existsSync(yml)) throw new Error(`No latest.yml in ${o.release}.`);
      const r = channelLatestYml(readFileSync(yml, 'utf8'), o.repo, o.tag);
      writeFileSync(join(out, 'latest.yml'), r.text);
      console.log(`latest.yml: ${r.changed} file names now on ${o.tag}`);
    }
    const idxFile = join(resolve(root, o.plugins), 'index.json');
    if (!existsSync(idxFile)) throw new Error(`No index.json in ${o.plugins} (npm run pack:plugins first).`);
    const idx = channelIndex(JSON.parse(readFileSync(idxFile, 'utf8')), o.repo, o.pluginsTag ?? o.tag);
    writeFileSync(join(out, 'index.json'), `${JSON.stringify(idx, null, 2)}\n`);
    console.log(`index.json: ${idx.plugins.map((p) => `${p.name} ${p.version}`).join(', ')}`);
    if (o.channelJson) {
      writeFileSync(join(out, 'channel.json'), '{}\n');
      console.log('channel.json: {} (no mark)');
    }
    console.log(`Written to ${out}`);
  } catch (err) {
    console.error(`release:channel: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
