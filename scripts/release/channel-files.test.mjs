import { describe, expect, it } from 'vitest';
import { parseLatestYml } from '../../apps/desktop/src/shared/updates';
import { assetUrl, channelIndex, channelLatestYml } from './channel-files.mjs';

const repo = 'example/spica';
const yml = [
  'version: 0.2.0-rc.5',
  'files:',
  '  - url: Spica-Setup-0.2.0-rc.5.exe',
  '    sha512: abc==',
  '    size: 100',
  'path: Spica-Setup-0.2.0-rc.5.exe',
  'sha512: abc==',
  "releaseDate: '2026-11-20T00:00:00.000Z'",
  '',
].join('\n');

describe('channel files', () => {
  it('latest.yml: the installer by its full address on its release, which the app reads and checks as before', () => {
    const r = channelLatestYml(yml, repo, 'v0.2.0-rc.5');
    const exe = 'https://github.com/example/spica/releases/download/v0.2.0-rc.5/Spica-Setup-0.2.0-rc.5.exe';
    expect(r.changed).toBe(2);
    expect(r.text).toContain(`  - url: ${exe}\n`);
    expect(r.text).toContain(`path: ${exe}\n`);
    expect(r.text).toContain("releaseDate: '2026-11-20T00:00:00.000Z'");
    expect(parseLatestYml(r.text)).toEqual({ version: '0.2.0-rc.5', path: exe, sha512: 'abc==' });
  });

  it('latest.yml: refuses one that already has addresses, names a file elsewhere, or has no version', () => {
    expect(() => channelLatestYml(channelLatestYml(yml, repo, 'v1').text, repo, 'v1')).toThrow(/already has a full address/);
    expect(() => channelLatestYml(yml.replace('path: Spica', 'path: ../Spica'), repo, 'v1')).toThrow(/outside its folder/);
    expect(() => channelLatestYml('path: a.exe\n', repo, 'v1')).toThrow(/no version/);
  });

  it('index.json: every package by its full address on the release that holds it (a plugin-only one too)', () => {
    const idx = { index_version: 1, plugins: [{ name: 'notes', version: '1.2.0', file: 'notes-1.2.0.zip', sha256: 'aa' }] };
    expect(channelIndex(idx, repo, 'plugins-2026.11.20').plugins[0]).toEqual({ name: 'notes', version: '1.2.0', file: 'https://github.com/example/spica/releases/download/plugins-2026.11.20/notes-1.2.0.zip', sha256: 'aa' });
    expect(() => channelIndex({ index_version: 1, plugins: [{ name: 'n', version: '1.0.0', file: 'n.zip' }] }, repo, 'v1')).toThrow(/no SHA-256/);
    expect(() => channelIndex({ plugins: [] }, repo, 'v1')).toThrow(/not a plugin index/);
  });

  it('addresses are encoded', () => {
    expect(assetUrl(repo, 'v1', 'Nova Desk-Setup-1.0.0.exe')).toBe('https://github.com/example/spica/releases/download/v1/Nova%20Desk-Setup-1.0.0.exe');
  });
});
