import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { expandCommand, insidePlugin, parseFrontmatter, readPluginFolder } from './folder.ts';
import { compareVersions, parseManifest, satisfies } from './manifest.ts';

const example = fileURLToPath(new URL('../../../plugins/example-notes', import.meta.url));
const good = {
  manifest_version: 1,
  name: 'demo',
  version: '1.0.0',
  description: 'A demo',
  author: { name: 'Someone' },
  license: 'MIT',
  compatibility: { spica: '>=0.1.0' },
};

describe('manifest', () => {
  it('accepts a good manifest and fills defaults', () => {
    const { manifest, issues } = parseManifest(JSON.stringify(good));
    expect(issues).toEqual([]);
    expect(manifest).toMatchObject({ name: 'demo', displayName: 'demo', permissions: { workspace: 'none', hooks: [] }, mock: { supported: false } });
  });

  it('explains every problem in plain words, with where it is', () => {
    const { manifest, issues } = parseManifest(
      JSON.stringify({ manifest_version: 2, name: 'Bad Name', version: '1.0', permissions: { hooks: ['onStart'], workspace: 'all' } }),
    );
    expect(manifest).toBeUndefined();
    const text = issues.map((i) => `${i.where} ${i.message}`).join('\n');
    expect(text).toContain('manifest_version');
    expect(text).toMatch(/name.*小写字母/);
    expect(text).toMatch(/version.*1\.2\.3/);
    expect(text).toContain('缺少「description」');
    expect(text).toContain('缺少作者');
    expect(text).toContain('不认识的钩子「onStart」');
    expect(text).toContain('permissions.workspace');
  });

  it('reports broken JSON instead of throwing', () => {
    const { issues } = parseManifest('{ "name": "x", }');
    expect(issues[0]!.message).toMatch(/不是合法的 JSON/);
  });

  it('compares versions and ranges', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1);
    expect(satisfies('0.1.0', '>=0.1.0 <1.0.0')).toBe(true);
    expect(satisfies('0.2.0', '^0.1.0')).toBe(false);
    expect(satisfies('1.4.2', '^1.2')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
  });
});

describe('plugin folder', () => {
  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('reads the example plugin with all parts and no issues', async () => {
    const f = await readPluginFolder(example);
    expect(f.issues).toEqual([]);
    expect(f.manifest?.name).toBe('notes');
    expect(f.skills.map((s) => s.id)).toEqual(['note-taking']);
    expect(f.commands.map((c) => c.id)).toEqual(['note']);
    expect(f.servers).toMatchObject([{ id: 'notes', kind: 'mcp', runtime: 'node', exposeTools: true }]);
    expect(f.hooks.map((h) => h.id)).toEqual(['notes-hint.js']);
  });

  it('keeps paths inside the plugin and refuses console scripts', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'spica-folder-'));
    await writeFile(join(tmp, 'manifest.json'), JSON.stringify(good));
    await mkdir(join(tmp, 'mcp'));
    await writeFile(join(tmp, 'mcp', 'escape.json'), JSON.stringify({ runtime: 'node', entry: '../outside.js' }));
    await writeFile(join(tmp, 'mcp', 'script.json'), JSON.stringify({ runtime: 'binary', entry: 'bin/run.cmd' }));
    await writeFile(join(tmp, 'mcp', 'py.json'), JSON.stringify({ runtime: 'python', entry: 'server.py' }));
    await writeFile(join(tmp, 'mcp', 'env.json'), JSON.stringify({ runtime: 'node', entry: 's.js', env: { SPICA_MOCK: '1' } }));
    const f = await readPluginFolder(tmp);
    const text = f.issues.map((i) => `${i.where}: ${i.message}`).join('\n');
    expect(text).toMatch(/escape\.json.*不能用绝对路径或 \.\./);
    expect(text).toMatch(/script\.json.*控制台窗口/);
    expect(text).toMatch(/py\.json.*独立可执行文件/);
    expect(text).toMatch(/env\.json.*SPICA_/);
    expect(f.servers).toEqual([]);
    expect(insidePlugin(tmp, 'C:\\Windows\\x.exe')).toBeUndefined();
    expect(insidePlugin(tmp, 'a/../../b')).toBeUndefined();
    expect(insidePlugin(tmp, 'bin/ok.exe')).toBe(join(tmp, 'bin', 'ok.exe'));
  });

  it('a folder without manifest says so', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'spica-folder-'));
    const f = await readPluginFolder(tmp);
    expect(f.issues[0]!.message).toMatch(/没有 manifest\.json/);
  });

  it('parses frontmatter and expands command arguments', () => {
    const { data, body } = parseFrontmatter('---\r\ndescription: "Say hi"\r\nargument-hint: <name>\r\n---\r\nHello $1, all: $ARGUMENTS\r\n');
    expect(data).toEqual({ description: 'Say hi', 'argument-hint': '<name>' });
    expect(expandCommand({ id: 'hi', description: '', template: body, file: '' }, 'Ann Bob')).toBe('Hello Ann, all: Ann Bob');
  });
});
