import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { nextVersion } from './version.mjs';

const here = dirname(fileURLToPath(import.meta.url));

describe('nextVersion', () => {
  it('takes an exact target from a prerelease to the next prerelease', () => {
    expect(nextVersion('0.1.0-rc.2', '0.1.0-rc.3')).toEqual({ next: '0.1.0-rc.3' });
  });
  it('takes an exact target from a prerelease to the final release', () => {
    expect(nextVersion('0.1.0-rc.3', '0.1.0')).toEqual({ next: '0.1.0' });
  });
  it('counts patch up from a plain x.y.z', () => {
    expect(nextVersion('0.1.0', 'patch')).toEqual({ next: '0.1.1' });
    expect(nextVersion('0.1.0', '0.1.1')).toEqual({ next: '0.1.1' });
  });
  it('counts minor and major up', () => {
    expect(nextVersion('1.2.3', 'minor')).toEqual({ next: '1.3.0' });
    expect(nextVersion('1.2.3', 'major')).toEqual({ next: '2.0.0' });
  });
  it('accepts a leading v', () => {
    expect(nextVersion('0.1.0-rc.2', 'v0.1.0-rc.3')).toEqual({ next: '0.1.0-rc.3' });
  });
  it('refuses a keyword from a prerelease and asks for the exact version', () => {
    const r = nextVersion('0.1.0-rc.3', 'patch');
    expect(r).toHaveProperty('error');
    expect(r.error).toContain('give the exact version');
  });
  it('refuses something that is not a version', () => {
    expect(nextVersion('0.1.0', '0.1')).toHaveProperty('error');
    expect(nextVersion('0.1.0', 'next')).toHaveProperty('error');
  });
  it('refuses the current version', () => {
    expect(nextVersion('0.1.0-rc.3', '0.1.0-rc.3')).toHaveProperty('error');
  });
});

// The whole script in a throwaway git repository: files, commit and tag.
describe('release:prepare in a scratch repository', { timeout: 60_000 }, () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true, env }).trim();
  const json = (rel) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));
  const write = (rel, data) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), JSON.stringify(data, null, 2) + '\n');
  };

  function setup(version) {
    dir = mkdtempSync(join(tmpdir(), 'spica-prepare-test-'));
    mkdirSync(join(dir, 'scripts/release'), { recursive: true });
    for (const f of ['prepare.mjs', 'version.mjs']) copyFileSync(join(here, f), join(dir, 'scripts/release', f));
    write('package.json', { name: 'spica', version, private: true });
    write('apps/desktop/package.json', { name: '@spica/desktop', version, private: true });
    write('package-lock.json', {
      name: 'spica',
      version,
      lockfileVersion: 3,
      packages: { '': { name: 'spica', version }, 'apps/desktop': { name: '@spica/desktop', version } },
    });
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  }

  function prepare(...args) {
    return execFileSync(process.execPath, [join(dir, 'scripts/release/prepare.mjs'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      env,
    });
  }

  function expectReleased(version) {
    expect(json('package.json').version).toBe(version);
    expect(json('apps/desktop/package.json').version).toBe(version);
    const lock = json('package-lock.json');
    expect(lock.version).toBe(version);
    expect(lock.packages[''].version).toBe(version);
    expect(lock.packages['apps/desktop'].version).toBe(version);
    expect(git('tag', '--list', `v${version}`)).toBe(`v${version}`);
    expect(git('log', '-1', '--format=%s')).toBe(`Release v${version}`);
    expect(git('status', '--porcelain')).toBe('');
  }

  it.each([
    ['0.1.0-rc.2', '0.1.0-rc.3'],
    ['0.1.0-rc.3', '0.1.0'],
    ['0.1.0', '0.1.1'],
  ])('%s -> %s', (from, to) => {
    setup(from);
    prepare(to);
    expectReleased(to);
  });

  it('0.1.0 -> patch gives 0.1.1', () => {
    setup('0.1.0');
    prepare('patch');
    expectReleased('0.1.1');
  });

  it('--dry-run changes nothing', () => {
    setup('0.1.0-rc.2');
    expect(prepare('0.1.0-rc.3', '--dry-run')).toContain('0.1.0-rc.2 -> 0.1.0-rc.3');
    expect(json('apps/desktop/package.json').version).toBe('0.1.0-rc.2');
    expect(git('tag', '--list')).toBe('');
  });
});
