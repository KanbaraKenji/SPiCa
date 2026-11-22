import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyMcpDraft, type McpServerDraft } from '../../shared/mcp-servers';
import { runMcp, type McpBackend, type McpState } from './service';
import { McpServerStore } from './store';

// A box that seals by reversing and marking (the real one is safeStorage).
const box = { available: () => true, encrypt: (p: string) => `S:${[...p].reverse().join('')}`, decrypt: (s: string) => [...s.slice(2)].reverse().join('') };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(states: McpState[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'spica-mcp-store-'));
  dirs.push(dir);
  const store = new McpServerStore(dir, box);
  const backend: McpBackend = { set: vi.fn(async () => states), states: vi.fn(async () => states), download: vi.fn(async () => states) };
  const deps = { store, backend, taken: async () => ['mail'] };
  return { dir, store, backend, deps };
}

const draft = (patch: Partial<McpServerDraft> = {}): McpServerDraft => ({ ...emptyMcpDraft(), name: 'notes', command: 'uvx', args: 'example-notes\nD:\\Notes Folder', env: [{ name: 'NOTES_TOKEN', value: 'nt-secret-value-0000-8f2c' }], ...patch });

describe('MCP services in the main process', () => {
  it('saves with the value sealed (not in the file), shows a mask, hands the backend the clear value', async () => {
    const { dir, store, backend, deps } = setup();
    const r = await runMcp({ op: 'save', was: null, draft: draft() }, deps);
    expect(r.errors).toBeUndefined();
    const file = readFileSync(join(dir, 'mcp-servers.json'), 'utf8');
    expect(file).not.toContain('nt-secret-value');
    expect(r.list.servers[0]).toMatchObject({ name: 'notes', command: 'uvx', args: ['example-notes', 'D:\\Notes Folder'], env: [{ name: 'NOTES_TOKEN', mask: 'nt-s****8f2c' }], enabled: true, approval: 'ask' });
    expect(backend.set).toHaveBeenCalledWith([{ name: 'notes', command: 'uvx', args: ['example-notes', 'D:\\Notes Folder'], env: { NOTES_TOKEN: 'nt-secret-value-0000-8f2c' }, enabled: true, approval: 'ask' }]);
    // and it is read back the same by a new store
    expect(new McpServerStore(dir, box).configs()[0]!.env).toEqual({ NOTES_TOKEN: 'nt-secret-value-0000-8f2c' });
    expect(store.list()).toHaveLength(1);
  });

  it('editing: a variable left empty keeps its value; a plugin\'s name or another service\'s is refused', async () => {
    const { store, deps } = setup();
    await runMcp({ op: 'save', was: null, draft: draft() }, deps);
    await runMcp({ op: 'save', was: 'notes', draft: draft({ command: 'uvx', env: [{ name: 'NOTES_TOKEN', saved: true }], approval: 'auto' }) }, deps);
    expect(store.configs()[0]).toMatchObject({ env: { NOTES_TOKEN: 'nt-secret-value-0000-8f2c' }, approval: 'auto' });
    expect((await runMcp({ op: 'save', was: null, draft: draft({ name: 'mail' }) }, deps)).errors).toEqual({ name: '名称已被使用' });
    expect((await runMcp({ op: 'save', was: null, draft: draft({ name: 'Notes' }) }, deps)).errors).toEqual({ name: '名称已被使用' });
    expect((await runMcp({ op: 'save', was: null, draft: draft({ name: 'x', env: [{ name: 'A' }] }) }, deps)).errors?.env).toBeTruthy();
    expect(store.list()).toHaveLength(1);
  });

  it('the list: how each is doing, tools without the prefix, what a waiting one would download; switched off is off', async () => {
    const states: McpState[] = [
      { name: 'notes', status: 'running', tools: ['notes__hello'], logTail: [] },
      { name: 'docs', status: 'needs-download', tools: [], logTail: [], download: { runner: 'npx', package: '@example/docs@3', python: false, version: '3.0.1', bytes: 40960 } },
    ];
    const { deps } = setup(states);
    await runMcp({ op: 'save', was: null, draft: draft() }, deps);
    await runMcp({ op: 'save', was: null, draft: draft({ name: 'docs', command: 'npx', args: '-y\n@example/docs', env: [] }) }, deps);
    const r = await runMcp({ op: 'list' }, deps);
    expect(r.list.servers.map((s) => [s.name, s.status, s.tools])).toEqual([
      ['notes', 'running', ['hello']],
      ['docs', 'needs-download', []],
    ]);
    expect(r.list.servers[1]!.download).toEqual({ packages: [{ name: '@example/docs', version: '3.0.1', bytes: 40960 }], packageHost: 'registry.npmjs.org' });
    expect(r.list.taken).toEqual(['mail']);
    const off = await runMcp({ op: 'setEnabled', name: 'notes', on: false }, deps);
    expect(off.list.servers[0]).toMatchObject({ status: 'off', tools: [] });
  });

  it('download goes to the backend; remove forgets it', async () => {
    const { store, backend, deps } = setup();
    await runMcp({ op: 'save', was: null, draft: draft() }, deps);
    await runMcp({ op: 'download', name: 'notes' }, deps);
    expect(backend.download).toHaveBeenCalledWith('notes');
    await runMcp({ op: 'remove', name: 'notes' }, deps);
    expect(store.list()).toEqual([]);
    expect(backend.set).toHaveBeenLastCalledWith([]);
  });

  it('a web address: the key and headers sealed, masks shown, the backend gets Authorization: Bearer; empty keeps them', async () => {
    const { dir, store, backend, deps } = setup();
    const web = (patch: Partial<McpServerDraft> = {}): McpServerDraft => ({ ...emptyMcpDraft(), name: 'docs', kind: 'url', url: 'https://mcp.example.com/mcp', key: 'Bearer dk-secret-value-0000-77aa', headers: [{ name: 'X-Team', value: 'team-secret-docs' }], ...patch });
    const r = await runMcp({ op: 'save', was: null, draft: web() }, deps);
    expect(r.errors).toBeUndefined();
    const file = readFileSync(join(dir, 'mcp-servers.json'), 'utf8');
    expect(file).not.toMatch(/dk-secret|team-secret/);
    expect(r.list.servers[0]).toMatchObject({ name: 'docs', url: 'https://mcp.example.com/mcp', key: 'dk-s****77aa', headers: [{ name: 'X-Team', mask: expect.stringContaining('****') }], command: '', args: [] });
    expect(backend.set).toHaveBeenLastCalledWith([
      { name: 'docs', url: 'https://mcp.example.com/mcp', headers: { 'X-Team': 'team-secret-docs', Authorization: 'Bearer dk-secret-value-0000-77aa' }, command: '', args: [], env: {}, enabled: true, approval: 'ask' },
    ]);
    // edited with the key and the header left empty: both kept
    await runMcp({ op: 'save', was: 'docs', draft: web({ key: '', keySaved: true, headers: [{ name: 'X-Team', saved: true }] }) }, deps);
    expect(store.configs()[0]!.headers).toEqual({ 'X-Team': 'team-secret-docs', Authorization: 'Bearer dk-secret-value-0000-77aa' });
    // the key taken away
    await runMcp({ op: 'save', was: 'docs', draft: web({ key: '', headers: [] }) }, deps);
    expect(store.configs()[0]!.headers).toEqual({});
    expect((await runMcp({ op: 'save', was: null, draft: web({ name: 'x', url: 'http://mcp.example.com' }) }, deps)).errors?.url).toBeTruthy();
  });

  it('a computer that cannot seal: the value is not saved, and says so', async () => {
    const { dir } = setup();
    const store = new McpServerStore(dir, { ...box, available: () => false });
    expect(store.save(null, draft(), [])).toEqual({ '': '此电脑无法加密保存，环境变量未保存' });
    expect(store.list()).toEqual([]);
  });
});
