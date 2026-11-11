// Enable / disable lifecycle against a real @spica/core runtime and real
// server processes (the example plugin and small throwaway plugins).
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// These tests start real server processes; give them room on a busy machine.
vi.setConfig({ testTimeout: 30_000 });
import { Runtime } from '@spica/core';
import { PluginManager } from './manager.ts';
import { pluginMethods } from './backend.ts';
import { runtimeHost } from './host.ts';
import { readPluginFolder } from './folder.ts';
import { unpackPlugin } from './pack.ts';
import { writeZip } from './zip.ts';
import { EXAMPLE_PLUGIN, OUTLOOK_PLUGIN, callTool, hookCtx, makeRuntime, manifest, rig, toolNames, until, writePlugin, type Rig } from './testing/helpers.ts';

let r: Rig | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await r?.cleanup();
  r = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const NOTES_TOOLS = ['notes__list_notes', 'notes__read_note', 'notes__write_note', 'notes__delete_note', 'notes__summarize_note', 'notes__search_catalog'];

describe('enable and disable', () => {
  it('J6: installed plugin tools appear, work, and disappear completely on disable', async () => {
    r = await rig();
    const { rt, pm } = r;
    const installed = await pm.install(EXAMPLE_PLUGIN, { kind: 'folder', location: EXAMPLE_PLUGIN });
    expect(installed.enabled).toBe(false);
    expect(toolNames(rt)).toEqual([]);

    const d = await pm.enable('notes');
    expect(toolNames(rt).sort()).toEqual(['notes__skill', ...NOTES_TOOLS].sort());
    expect(d.tools.sort()).toEqual(['notes__skill', ...NOTES_TOOLS].sort());
    expect(d.servers).toMatchObject([{ id: 'notes', status: 'running' }]);

    expect(await callTool(rt, 'notes__write_note', { title: 'plans', text: 'ship J6' })).toMatchObject({ content: expect.stringContaining('Saved') });
    expect((await callTool(rt, 'notes__read_note', { title: 'plans' })).content).toContain('ship J6');
    // Notes live in the plugin's data folder.
    expect(await readFile(join(pm.dataDir('notes'), 'notes', 'plans.md'), 'utf8')).toContain('ship J6');

    // Skill index and the hook's line are injected while enabled.
    const inj = await rt.hooks.injections(hookCtx);
    expect(inj.map((i) => i.text).join('\n')).toMatch(/note-taking: How to keep tidy notes[\s\S]*Notes plugin is active/);
    expect((await callTool(rt, 'notes__skill', { id: 'note-taking' })).content).toContain('Start every entry with the date');

    await pm.disable('notes');
    expect(toolNames(rt)).toEqual([]);
    expect(rt.hooks.sources).toEqual([]);
    expect(await rt.hooks.injections(hookCtx)).toEqual([]);
    expect(pm.describe('notes')).toMatchObject({ enabled: false, tools: [], servers: [{ status: 'stopped' }] });
    expect(r.events.map((e) => e.type)).toEqual(expect.arrayContaining(['plugin.installed', 'plugin.enabled', 'plugin.disabled']));
  });

  it('describe() lists skills, commands, tools, hooks and processes for the plugin page', async () => {
    r = await rig();
    await r.pm.install(EXAMPLE_PLUGIN);
    await r.pm.enable('notes');
    const d = r.pm.describe('notes');
    expect(d).toMatchObject({
      displayName: 'Notes (example)',
      mockSupported: true,
      permissions: { irreversible: ['delete_note'], hooks: ['inject'], workspace: 'none' },
      skills: [{ id: 'note-taking', name: 'Note taking' }],
      commands: [{ id: 'note', argumentHint: '<what to note>' }],
      hooks: [{ module: 'notes-hint.js', kinds: ['inject'] }],
      servers: [{ id: 'notes', kind: 'mcp', runtime: 'node', status: 'running', restarts: 0 }],
    });
    expect(r.pm.commands()).toEqual([{ name: 'notes:note', plugin: 'notes', description: 'Save something to the notebook', argumentHint: '<what to note>' }]);
    expect(r.pm.expandCommand('/notes:note', 'buy milk')).toBe('Save this to my notebook, following the note-taking skill: buy milk');
  });

  it('tools declared irreversible need confirmation', async () => {
    r = await rig();
    await r.pm.install(EXAMPLE_PLUGIN);
    await r.pm.enable('notes');
    const del = await r.rt.hooks.beforeTool({ callId: 'c', name: 'notes__delete_note', input: { title: 'x' }, irreversible: false }, hookCtx);
    expect(del.decision).toMatchObject({ action: 'confirm' });
    const write = await r.rt.hooks.beforeTool({ callId: 'c', name: 'notes__write_note', input: {}, irreversible: false }, hookCtx);
    expect(write.decision).toEqual({ action: 'allow' });
  });

  it('mock mode switches the server to sample data and back', async () => {
    r = await rig();
    await r.pm.install(EXAMPLE_PLUGIN);
    await r.pm.enable('notes');
    const off = await callTool(r.rt, 'notes__search_catalog', { query: 'clocks' });
    expect(off).toMatchObject({ isError: true, content: expect.stringContaining('Turn on mock mode') });

    await r.pm.setMock(true);
    expect(r.pm.mock).toBe(true);
    const on = await callTool(r.rt, 'notes__search_catalog', { query: 'clocks' });
    expect(on.content).toMatch(/sample data[\s\S]*A Short History of Clocks/);
    expect((await r.rt.hooks.injections(hookCtx)).map((i) => i.text).join()).toContain('mock mode');
    expect(r.events).toContainEqual({ type: 'mock.changed', on: true });

    await r.pm.setMock(false);
    expect((await callTool(r.rt, 'notes__search_catalog', { query: 'clocks' })).isError).toBe(true);
  });

  it('restarting a server (mock switch) keeps the plugin\'s other tools and hooks', async () => {
    r = await rig();
    await r.pm.install(EXAMPLE_PLUGIN);
    await r.pm.enable('notes');
    const before = toolNames(r.rt).sort();
    await r.pm.setMock(true);
    expect(toolNames(r.rt).sort()).toEqual(before);
    expect(r.rt.hooks.sources).toEqual(['plugin:notes']);
  });

  it('state survives a restart: enabled plugins come back, mock setting kept', async () => {
    r = await rig();
    await r.pm.install(EXAMPLE_PLUGIN);
    await r.pm.enable('notes');
    await r.pm.setMock(true);
    await r.pm.shutdown();
    expect(toolNames(r.rt)).toEqual([]);

    const pm2 = new PluginManager({ host: runtimeHost(r.rt), root: r.root });
    const loaded = await pm2.load();
    expect(loaded).toEqual({ enabled: ['notes'], failed: [] });
    expect(pm2.mock).toBe(true);
    expect(toolNames(r.rt)).toContain('notes__search_catalog');
    await pm2.shutdown();
  });
});

describe('mail source', () => {
  const server = `import { createInterface } from 'node:readline';
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    const tools = ['list_messages', 'read_message'].map((name) => ({ name, inputSchema: { type: 'object' } }));
    createInterface({ input: process.stdin }).on('line', (l) => {
      const m = JSON.parse(l);
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'm' } } });
      if (m.method === 'tools/list') send({ id: m.id, result: { tools } });
      if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ messages: [] }) }] } });
    });`;

  it('a plugin that declares mail joins the mail pipeline while enabled, and leaves it on disable', async () => {
    const dir = await writePlugin({
      'manifest.json': manifest('mailer', { mail: { list_tool: 'list_messages', read_tool: 'read_message', list_args: { unread_only: true, limit: 10 } } }),
      'mcp/box.json': { runtime: 'node', entry: 'srv.js' },
      'srv.js': server,
    });
    dirs.push(dir);
    r = await rig();
    await r.pm.install(dir);
    expect(r.rt.mail.activeSources).toEqual([]);
    const d = await r.pm.enable('mailer');
    expect(d.mail).toEqual({ listTool: 'mailer__list_messages', readTool: 'mailer__read_message' });
    expect(r.rt.mail.activeSources).toEqual([
      { id: 'mailer', listTool: 'mailer__list_messages', readTool: 'mailer__read_message', listArgs: { unread_only: true, limit: 10 } },
    ]);
    await r.pm.disable('mailer');
    expect(r.rt.mail.activeSources).toEqual([]);
    expect(r.pm.describe('mailer').mail).toBeUndefined();
    // Enabling again registers it once, not twice.
    await r.pm.enable('mailer');
    expect(r.rt.mail.activeSources).toHaveLength(1);
  });

  it('a wrong mail declaration is explained', async () => {
    const dir = await writePlugin({
      'manifest.json': manifest('badmail', { mail: { list_tool: 'list_messages' } }),
    });
    dirs.push(dir);
    r = await rig();
    await expect(r.pm.install(dir)).rejects.toThrow(/mail[\s\S]*read_tool/);
    const dir2 = await writePlugin({ 'manifest.json': manifest('nomcp', { mail: { list_tool: 'a', read_tool: 'b' } }) });
    dirs.push(dir2);
    await expect(r.pm.install(dir2)).rejects.toThrow(/声明了邮件来源，但插件里没有 MCP server/);
  });
});

describe('views (plugin pages)', () => {
  it('lists pages of enabled plugins, serves only their own files, and withdraws them on disable', async () => {
    r = await rig();
    const { pm } = r;
    await pm.install(EXAMPLE_PLUGIN);
    expect(pm.describe('notes').views).toEqual([
      { id: 'notebook', title: 'Notebook', placement: 'sidebar', entry: 'ui/index.html', icon: 'ui/icon.svg', tools: ['list_notes', 'read_note', 'write_note', 'delete_note'] },
      { id: 'quick-note', title: 'Quick note', placement: 'panel', entry: 'ui/quick-note.html', icon: 'ui/icon.svg', tools: ['read_note', 'write_note'] },
    ]);
    expect(pm.views()).toEqual([]);
    expect(await pm.resolveViewFile('notes', 'ui/index.html')).toBeUndefined();

    await pm.enable('notes');
    expect(pm.views()).toEqual([
      {
        plugin: 'notes',
        pluginTitle: 'Notes (example)',
        id: 'notebook',
        title: 'Notebook',
        placement: 'sidebar',
        entry: 'ui/index.html',
        icon: 'ui/icon.svg',
        tools: ['list_notes', 'read_note', 'write_note', 'delete_note'],
        irreversible: ['delete_note'],
      },
      {
        plugin: 'notes',
        pluginTitle: 'Notes (example)',
        id: 'quick-note',
        title: 'Quick note',
        placement: 'panel',
        entry: 'ui/quick-note.html',
        icon: 'ui/icon.svg',
        tools: ['read_note', 'write_note'],
        irreversible: [],
      },
    ]);
    const root = join(pm.installDir('notes', '0.1.0'));
    expect(await pm.resolveViewFile('notes', 'ui/app.js')).toBe(join(root, 'ui', 'app.js'));
    expect(await pm.resolveViewFile('notes', '/ui/style.css')).toBe(join(root, 'ui', 'style.css'));
    for (const bad of ['../state.json', 'ui/../../state.json', '..\\state.json', 'C:/Windows/win.ini', 'ui/missing.js', 'ui', '']) {
      expect(await pm.resolveViewFile('notes', bad)).toBeUndefined();
    }
    expect(await pm.resolveViewFile('other', 'ui/app.js')).toBeUndefined();

    await pm.disable('notes');
    expect(pm.views()).toEqual([]);
    expect(await pm.resolveViewFile('notes', 'ui/app.js')).toBeUndefined();
  });

  it('a page calls only its own declared tools; irreversible ones need confirmation', async () => {
    r = await rig();
    const { pm } = r;
    await pm.install(EXAMPLE_PLUGIN);
    expect(await pm.viewCall('notes', 'notebook', 'list_notes')).toMatchObject({ isError: true, content: expect.stringMatching(/^\[PLUGIN_DISABLED\]/) });
    await pm.enable('notes');

    expect(await pm.viewCall('notes', 'notebook', 'write_note', { title: 'page', text: 'from the page' })).toMatchObject({ isError: false, content: expect.stringContaining('Saved') });
    expect(await pm.viewCall('notes', 'notebook', 'read_note', { title: 'page' })).toMatchObject({ isError: false, content: expect.stringContaining('from the page') });
    expect((await pm.viewCall('notes', 'notebook', 'list_notes')).content).toContain('- page (');

    expect((await pm.viewCall('notes', 'notebook', 'search_catalog', { query: 'x' })).content).toMatch(/^\[TOOL_NOT_ALLOWED\]/);
    expect((await pm.viewCall('notes', 'notebook', 'skill')).content).toMatch(/^\[TOOL_NOT_FOUND\]/);
    expect((await pm.viewCall('notes', 'nope', 'list_notes')).content).toMatch(/^\[VIEW_NOT_FOUND\]/);
    // The panel may only read and write.
    expect((await pm.viewCall('notes', 'quick-note', 'delete_note', { title: 'page' }, { confirmed: true })).content).toMatch(/^\[TOOL_NOT_ALLOWED\]/);
    expect((await pm.viewCall('notes', 'quick-note', 'write_note', { title: 'Inbox', text: 'one line' })).isError).toBe(false);

    const asked = await pm.viewCall('notes', 'notebook', 'delete_note', { title: 'page' });
    expect(asked).toMatchObject({ isError: true, content: expect.stringMatching(/^\[CONFIRM_REQUIRED\]/) });
    expect((await pm.viewCall('notes', 'notebook', 'read_note', { title: 'page' })).isError).toBe(false); // still there
    expect(await pm.viewCall('notes', 'notebook', 'delete_note', { title: 'page' }, { confirmed: true })).toMatchObject({ isError: false });
    expect((await pm.viewCall('notes', 'notebook', 'read_note', { title: 'page' })).isError).toBe(true);
  });

  it("page calls go through the plugin's hooks: Outlook's attachment path guard applies", async () => {
    // The Outlook plugin plus a small page that may list mail and save attachments.
    const src = await mkdtemp(join(tmpdir(), 'spica-outlook-view-'));
    dirs.push(src);
    await cp(OUTLOOK_PLUGIN, src, { recursive: true, filter: (s) => !/[\\/](node_modules|test)([\\/]|$)/.test(s) });
    await mkdir(join(src, 'views'), { recursive: true });
    await mkdir(join(src, 'ui'), { recursive: true });
    await writeFile(join(src, 'views', 'files.json'), JSON.stringify({ title: 'Files', entry: 'ui/files.html', placement: 'panel', permissions: { tools: ['list_messages', 'save_attachments'] } }));
    await writeFile(join(src, 'ui', 'files.html'), '<!doctype html><title>Files</title>');
    const project = await mkdtemp(join(tmpdir(), 'spica-project-'));
    const outside = await mkdtemp(join(tmpdir(), 'spica-outside-'));
    dirs.push(project, outside);

    r = await rig(makeRuntime(undefined, { cwd: project }));
    await r.pm.setMock(true);
    await r.pm.install(src);
    await r.pm.enable('outlook');

    // An absolute folder outside the project: the server alone would save there; the hook refuses.
    const refused = await r.pm.viewCall('outlook', 'files', 'save_attachments', { id: 'mock-001', dest_folder: outside });
    expect(refused).toMatchObject({ isError: true, content: expect.stringMatching(/^\[PATH_NOT_ALLOWED\] 附件只能存到项目文件夹/) });
    expect(await readdir(outside)).toEqual([]);

    // A relative folder: the hook resolves it inside the project folder.
    const saved = await r.pm.viewCall('outlook', 'files', 'save_attachments', { id: 'mock-001', dest_folder: 'from-page' });
    expect(saved.isError, saved.content).toBe(false);
    expect(await readdir(join(project, 'from-page'))).toEqual(['order-PL-2207.csv']);

    // overwrite asks the user (the hook says confirm): the page gets CONFIRM_REQUIRED, nothing is written.
    const asked = await r.pm.viewCall('outlook', 'files', 'save_attachments', { id: 'mock-001', dest_folder: 'from-page', overwrite: true });
    expect(asked.content).toMatch(/^\[CONFIRM_REQUIRED\] 会覆盖项目文件夹里同名的文件/);
    expect(await readdir(join(project, 'from-page'))).toEqual(['order-PL-2207.csv']);
    expect((await r.pm.viewCall('outlook', 'files', 'save_attachments', { id: 'mock-001', dest_folder: 'from-page', overwrite: true }, { confirmed: true })).isError).toBe(false);
  });

  it("a page may call its plugin's service tools, which the model never gets", async () => {
    const server = `import { createInterface } from 'node:readline';
      const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
      createInterface({ input: process.stdin }).on('line', (l) => {
        const m = JSON.parse(l);
        if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's' } } });
        if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'stats', inputSchema: { type: 'object' } }] } });
        if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: '{"count":7}' }] } });
      });`;
    const dir = await writePlugin({
      'manifest.json': manifest('svcpage'),
      'services/backend.json': { runtime: 'node', entry: 'srv.js' },
      'srv.js': server,
      'views/main.json': { title: 'Main', entry: 'ui/index.html' },
      'ui/index.html': '<!doctype html><title>x</title>',
    });
    dirs.push(dir);
    r = await rig();
    await r.pm.install(dir);
    await r.pm.enable('svcpage');
    expect(r.pm.views()[0]?.tools).toEqual(['stats']);
    expect(await r.pm.viewCall('svcpage', 'main', 'stats')).toMatchObject({ isError: false, data: { count: 7 } });
    // The model is still refused.
    const { decision } = await r.rt.hooks.beforeTool({ callId: 'c', name: 'svcpage-backend__stats', input: {}, irreversible: false }, hookCtx);
    expect(decision.action).toBe('deny');
  });

  it('pages work before any model is configured (fresh install)', async () => {
    // A fresh desktop install: no provider, empty default. Page calls need no model.
    const rt = new Runtime({ providers: [], defaults: { providerId: '', model: '', maxTokens: 256 }, tools: [] });
    r = await rig(rt);
    await r.pm.install(EXAMPLE_PLUGIN);
    await r.pm.enable('notes');
    expect(await r.pm.viewCall('notes', 'notebook', 'write_note', { title: 'fresh', text: 'no model yet' })).toMatchObject({ isError: false });
    expect((await r.pm.viewCall('notes', 'notebook', 'read_note', { title: 'fresh' })).content).toContain('no model yet');
    expect((await r.pm.viewCall('notes', 'notebook', 'delete_note', { title: 'fresh' })).content).toMatch(/^\[CONFIRM_REQUIRED\]/);
    expect(await r.pm.viewCall('notes', 'notebook', 'delete_note', { title: 'fresh' }, { confirmed: true })).toMatchObject({ isError: false });
  });

  it('JSON results come back parsed as data', async () => {
    const server = `import { createInterface } from 'node:readline';
      const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
      createInterface({ input: process.stdin }).on('line', (l) => {
        const m = JSON.parse(l);
        if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's' } } });
        if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'stats', inputSchema: { type: 'object' } }] } });
        if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ count: 3 }) }] } });
      });`;
    const dir = await writePlugin({
      'manifest.json': manifest('paged'),
      'mcp/s.json': { runtime: 'node', entry: 'srv.js' },
      'srv.js': server,
      'views/main.json': { title: 'Main', entry: 'ui/index.html' },
      'ui/index.html': '<!doctype html><title>x</title>',
    });
    dirs.push(dir);
    r = await rig();
    await r.pm.install(dir);
    await r.pm.enable('paged');
    expect(r.pm.views()[0]).toMatchObject({ placement: 'sidebar', tools: ['stats'], irreversible: [] });
    expect(await r.pm.viewCall('paged', 'main', 'stats')).toEqual({ content: '{"count":3}', data: { count: 3 }, isError: false });
  });

  it('wrong view declarations are explained', async () => {
    const dir = await writePlugin({
      'manifest.json': manifest('badview'),
      'views/a.json': { title: 'A', entry: '../outside.html' },
      'views/b.json': { title: 'B', entry: 'ui/b.html', placement: 'detail' },
      'views/c.json': { title: 'C', entry: 'ui/missing.html' },
      'views/d.json': { title: 'D', entry: 'ui/b.html', permissions: { tools: ['badview__x'] } },
      'views/e.json': { title: 'E', entry: 'ui/b.html', icon: 'ui/b.html' },
      'views/f.json': '{ not json',
      'ui/b.html': '<!doctype html>',
    });
    dirs.push(dir);
    r = await rig();
    const check = await r.pm.check(dir);
    const text = check.issues.map((i) => `${i.where}: ${i.message}`).join('\n');
    expect(text).toMatch(/views\/a\.json: entry 须为插件文件夹内的相对路径/);
    expect(text).toMatch(/views\/b\.json: 视图的 placement 只能是 sidebar 或 panel/);
    expect(text).toMatch(/views\/c\.json: entry 指向的 ui\/missing\.html 不存在/);
    expect(text).toMatch(/views\/d\.json: permissions\.tools 须为本插件工具的原名列表/);
    expect(text).toMatch(/views\/e\.json: icon 须指向 \.svg 文件/);
    expect(text).toMatch(/views\/f\.json: 视图声明不是有效的 JSON/);
    expect(check.views).toEqual([]);
  });

  it('the plugin’s own icon: an .svg in its folder, up to 64 KB; describe() gives its path', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#4f7cff"/></svg>';
    const dir = await writePlugin({ 'manifest.json': { ...manifest('iconic'), icon: './art/icon.svg' }, 'art/icon.svg': svg });
    dirs.push(dir);
    r = await rig();
    await r.pm.install(dir);
    // One icon: both skins use it.
    expect(r.pm.describe('iconic').icon).toEqual({ light: 'art/icon.svg', dark: 'art/icon.svg' });
    // None declared: none described (the shell draws the letter badge).
    const plain = await writePlugin({ 'manifest.json': manifest('plain') });
    dirs.push(plain);
    await r.pm.install(plain);
    expect(r.pm.describe('plain').icon).toBeUndefined();
  });

  it('one icon for a light skin and one for a dark skin', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#4f7cff"/></svg>';
    const dir = await writePlugin({ 'manifest.json': { ...manifest('twotone'), icon: { light: 'icon-light.svg', dark: './art/icon-dark.svg' } }, 'icon-light.svg': svg, 'art/icon-dark.svg': svg });
    dirs.push(dir);
    r = await rig();
    await r.pm.install(dir);
    expect(r.pm.describe('twotone').icon).toEqual({ light: 'icon-light.svg', dark: 'art/icon-dark.svg' });
    // Each is checked; the one that is wrong is named.
    const bad = await writePlugin({ 'manifest.json': { ...manifest('twobad'), icon: { light: 'icon-light.svg', dark: 'missing.svg' } }, 'icon-light.svg': svg });
    dirs.push(bad);
    const check = await r.pm.check(bad);
    expect(check.issues.map((i) => `${i.where}: ${i.message}`).join('\n')).toMatch(/manifest\.json · icon\.dark: icon\.dark 指向的 missing\.svg 不存在/);
    expect(check.manifest?.icon).toBeUndefined();
    // Only one of the two, or not a path: said how to write it.
    const half = await writePlugin({ 'manifest.json': { ...manifest('twohalf'), icon: { light: 'icon-light.svg' } }, 'icon-light.svg': svg });
    dirs.push(half);
    expect((await r.pm.check(half)).issues.map((i) => `${i.where}: ${i.message}`).join('\n')).toMatch(/manifest\.json · icon: 「icon」须为插件文件夹里的 \.svg/);
  });

  it('a wrong icon is explained, and the plugin is not installed', async () => {
    const cases: [unknown, Record<string, string>, RegExp][] = [
      ['../outside.svg', {}, /manifest\.json · icon: icon 须为插件文件夹内的相对路径/],
      ['icon.png', { 'icon.png': 'x' }, /manifest\.json · icon: icon 须指向 \.svg 文件/],
      ['missing.svg', {}, /manifest\.json · icon: icon 指向的 missing\.svg 不存在/],
      ['big.svg', { 'big.svg': `<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(64 * 1024)}</svg>` }, /manifest\.json · icon: icon 文件不能大于 64 KB（当前 65 KB）/],
      [42, {}, /manifest\.json · icon/],
    ];
    r = await rig();
    for (const [icon, files, expected] of cases) {
      const dir = await writePlugin({ 'manifest.json': { ...manifest('badicon'), icon }, ...files });
      dirs.push(dir);
      const check = await r.pm.check(dir);
      expect(check.issues.map((i) => `${i.where}: ${i.message}`).join('\n')).toMatch(expected);
      expect(check.manifest?.icon).toBeUndefined();
      await expect(r.pm.install(dir)).rejects.toThrow();
    }
  });
});

describe('irreversible tools on every kind of server', () => {
  /** One tool, void_x; with `hint` it also carries MCP's destructiveHint. */
  const voidServer = (hint: boolean) => `import { createInterface } from 'node:readline';
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    createInterface({ input: process.stdin }).on('line', (l) => {
      const m = JSON.parse(l);
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's' } } });
      if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'void_x', inputSchema: { type: 'object' }${hint ? ', annotations: { destructiveHint: true }' : ''} }] } });
      if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: '{"voided":true}' }] } });
    });`;

  async function voidPlugin(name: string, dirName: 'services' | 'mcp', hint: boolean, serverExtra: Record<string, unknown> = {}): Promise<string> {
    const dir = await writePlugin({
      'manifest.json': manifest(name, { permissions: { irreversible: ['void_x'] } }),
      [`${dirName}/admin.json`]: { runtime: 'node', entry: 'srv.js', ...serverExtra },
      'srv.js': voidServer(hint),
      'views/main.json': { title: 'Main', entry: 'ui/index.html', permissions: { tools: ['void_x'] } },
      'ui/index.html': '<!doctype html><title>x</title>',
    });
    dirs.push(dir);
    return dir;
  }

  for (const [dirName, hint] of [['services', false], ['services', true], ['mcp', false]] as const) {
    it(`a page call to a declared irreversible ${dirName}/ tool (destructiveHint ${hint ? 'set' : 'not set'}) asks first, and runs once confirmed`, async () => {
      const name = `void-${dirName === 'mcp' ? 'm' : 's'}${hint ? 'h' : 'n'}`;
      r = await rig();
      await r.pm.install(await voidPlugin(name, dirName, hint));
      await r.pm.enable(name);
      expect(r.pm.views()[0]).toMatchObject({ irreversible: ['void_x'] });
      const asked = await r.pm.viewCall(name, 'main', 'void_x', {});
      expect(asked.content).toMatch(/^\[CONFIRM_REQUIRED\]/);
      expect(asked.isError).toBe(true);
      const done = await r.pm.viewCall(name, 'main', 'void_x', {}, { confirmed: true });
      expect(done).toMatchObject({ isError: false, data: { voided: true } });
    });
  }

  it('a services/ tool exposed to the model asks first too; a hidden one is still refused to the model', async () => {
    r = await rig();
    await r.pm.install(await voidPlugin('void-exposed', 'services', false, { expose_tools: true }));
    await r.pm.enable('void-exposed');
    const exposed = { callId: 'c', name: 'void-exposed-admin__void_x', input: {}, irreversible: false };
    expect(toolNames(r.rt)).toContain('void-exposed-admin__void_x');
    expect((await r.rt.hooks.beforeTool(exposed, hookCtx)).decision).toMatchObject({ action: 'confirm' });

    await r.pm.install(await voidPlugin('void-hidden', 'services', false));
    await r.pm.enable('void-hidden');
    const hidden = { callId: 'c', name: 'void-hidden-admin__void_x', input: {}, irreversible: false };
    // Deny for the model comes before the confirmation.
    expect((await r.rt.hooks.beforeTool(hidden, hookCtx)).decision).toMatchObject({ action: 'deny' });
  });
});

describe('app name in messages', () => {
  it('a branded build shows its own name; nothing else changes', async () => {
    const msg = { appName: 'Acme Desk' };
    // Manager: compatibility message.
    const rt = makeRuntime();
    const root = await mkdtemp(join(tmpdir(), 'spica-plugins-'));
    dirs.push(root);
    const pm = new PluginManager({ host: runtimeHost(rt), root, spicaVersion: '0.1.0', ...msg });
    expect(pm.appName).toBe('Acme Desk');
    const future = await writePlugin({ 'manifest.json': manifest('future', { compatibility: { spica: '>=9.0.0' } }) });
    dirs.push(future);
    await expect(pm.install(future)).rejects.toThrow(/这个插件要求 Acme Desk >=9.0.0/);
    // Folder and manifest checks.
    const odd = await writePlugin({
      'manifest.json': { ...(manifest('odd') as Record<string, unknown>), compatibility: undefined },
      'mcp/srv.json': { runtime: 'ruby', entry: 'srv.rb' },
      'srv.rb': '',
    });
    dirs.push(odd);
    const text = (await readPluginFolder(odd, msg)).issues.map((i) => i.message).join(' | ');
    expect(text).toContain('未声明 compatibility.spica，视为兼容所有版本。');
    expect(text).toContain('由 Acme Desk 自带的 Node 运行 .js');
    // Without a name, the default stays.
    expect((await readPluginFolder(odd)).issues.map((i) => i.message).join(' | ')).toContain('由 Spica 自带的 Node 运行 .js');
    // Not a plugin package.
    await expect(unpackPlugin(writeZip([{ name: 'readme.txt', data: Buffer.from('hi') }]), join(root, 'x'), msg)).rejects.toThrow('不是 Acme Desk 插件包');
    // Host without MCP support.
    const bare = runtimeHost({ ...rt, connectMcp: undefined } as never);
    await expect(bare.connectMcp!({ command: 'x' } as never, 'plugin:x')).rejects.toThrow('当前版本不支持启动 MCP server');
    await pm.shutdown();
  });
});

describe('failures', () => {
  it('a hook that fails to load rolls back the whole enable: nothing left behind', async () => {
    const dir = await writePlugin({
      'manifest.json': manifest('broken', { permissions: { hooks: ['inject'] } }),
      'mcp/srv.json': { runtime: 'node', entry: 'srv.js' },
      'srv.js': await readFile(join(EXAMPLE_PLUGIN, 'server', 'index.js'), 'utf8'),
      'hooks/bad.js': 'throw new Error("boom at import");',
      'skills/s/SKILL.md': '---\ndescription: d\n---\nbody',
    });
    dirs.push(dir);
    r = await rig();
    await r.pm.install(dir);
    await expect(r.pm.enable('broken')).rejects.toThrow(/启用失败.*hooks\/bad\.js 加载失败.*boom at import/);
    expect(toolNames(r.rt)).toEqual([]);
    expect(r.rt.hooks.sources).toEqual([]);
    expect(r.pm.describe('broken')).toMatchObject({ enabled: false, servers: [{ status: 'stopped' }] });
  });

  it('hook kinds not declared in the manifest are not registered; a throwing hook never breaks the run', async () => {
    const dir = await writePlugin({
      'manifest.json': manifest('hooky', { permissions: { hooks: ['inject', 'afterTool'] } }),
      'hooks/a.js': `export default {
        inject() { return [{ position: 'input:before', text: 'from hooky' }]; },
        afterTool() { throw new Error('afterTool exploded'); },
        beforeTool() { return { action: 'deny', reason: 'sneaky' }; },
      };`,
    });
    dirs.push(dir);
    r = await rig();
    await r.pm.install(dir);
    const d = await r.pm.enable('hooky');
    expect(d.hooks).toEqual([{ module: 'a.js', kinds: ['inject', 'afterTool'] }]);
    const call = { callId: 'c', name: 'anything', input: {}, irreversible: false };
    expect((await r.rt.hooks.beforeTool(call, hookCtx)).decision).toEqual({ action: 'allow' });
    expect(await r.rt.hooks.afterTool(call, { content: 'ok', isError: false }, hookCtx)).toEqual({ content: 'ok', isError: false });
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'hook.error', module: 'a.js', kind: 'afterTool', message: 'afterTool exploded' }));
    expect((await r.rt.hooks.injections(hookCtx))[0]).toMatchObject({ text: 'from hooky', source: 'plugin:hooky' });
  });

  it('a crashing server is restarted up to its limit, then reported in plain words', async () => {
    const dir = await writePlugin({
      'manifest.json': manifest('crashy'),
      'mcp/srv.json': { runtime: 'node', entry: 'srv.js', restart: { max_restarts: 2, window_seconds: 60 } },
      // Answers the handshake, then dies shortly after.
      'srv.js': `import { createInterface } from 'node:readline';
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
        createInterface({ input: process.stdin }).on('line', (l) => {
          const m = JSON.parse(l);
          if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'c' } } });
          if (m.method === 'tools/list') { send({ id: m.id, result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } }); setTimeout(() => { process.stderr.write('fatal: out of cheese\\n'); process.exit(3); }, 100); }
        });`,
    });
    dirs.push(dir);
    r = await rig();
    await r.pm.install(dir);
    await r.pm.enable('crashy');
    await until(() => r!.pm.describe('crashy').servers[0]!.status === 'failed', 10_000);
    const d = r.pm.describe('crashy');
    expect(d.servers[0]).toMatchObject({ status: 'failed', restarts: 2, lastError: expect.stringContaining('崩溃 3 次') });
    expect(toolNames(r.rt)).toEqual([]);
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'plugin.error', name: 'crashy', message: expect.stringContaining('已停止重启') }));
    expect(await readFile(r.pm.logFile('crashy'), 'utf8')).toContain('out of cheese');
  });

  it('plugin processes get only whitelisted host variables, never secrets', async () => {
    const dir = await writePlugin({
      'manifest.json': manifest('envy'),
      'mcp/srv.json': { runtime: 'node', entry: 'srv.js', env: { OWN_SETTING: 'mine' } },
      'srv.js': `import { createInterface } from 'node:readline';
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
        createInterface({ input: process.stdin }).on('line', (l) => {
          const m = JSON.parse(l);
          if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'e' } } });
          if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'env', inputSchema: { type: 'object' } }] } });
          if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: Object.keys(process.env).join(',') }] } });
        });`,
    });
    dirs.push(dir);
    // the computer and user name pass (set here: CI machines may not have them)
    const host = { COMPUTERNAME: process.env.COMPUTERNAME, USERNAME: process.env.USERNAME };
    process.env.COMPUTERNAME = host.COMPUTERNAME ?? 'TEST-PC';
    process.env.USERNAME = host.USERNAME ?? 'test-user';
    process.env.PLUGIN_TEST_PLAIN = 'x';
    process.env.PLUGIN_TEST_API_KEY = 'secret';
    try {
      r = await rig();
      await r.pm.install(dir);
      await r.pm.enable('envy');
      const names = (await callTool(r.rt, 'envy__env', {})).content.split(',');
      expect(names).toEqual(expect.arrayContaining(['OWN_SETTING', 'SPICA_PLUGIN_DATA', 'SPICA_MOCK']));
      const upper = names.map((n) => n.toUpperCase());
      expect(upper).toEqual(expect.arrayContaining(['PATH', 'COMPUTERNAME', 'USERNAME']));
      expect(names).not.toContain('PLUGIN_TEST_PLAIN');
      expect(names).not.toContain('PLUGIN_TEST_API_KEY');
    } finally {
      delete process.env.PLUGIN_TEST_PLAIN;
      delete process.env.PLUGIN_TEST_API_KEY;
      for (const [k, v] of Object.entries(host)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('a long tool that reports progress outlives timeout_seconds, up to max_call_seconds', async () => {
    // Scaled down: timeout_seconds 4 stands for 60 s; the tool reports progress every 0.2 s.
    const dir = await writePlugin({
      'manifest.json': manifest('slowpoke'),
      'mcp/srv.json': { runtime: 'node', entry: 'srv.js', timeout_seconds: 4, max_call_seconds: 8 },
      'srv.js': `import { createInterface } from 'node:readline';
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
        const jobs = new Map();
        createInterface({ input: process.stdin }).on('line', (l) => {
          const m = JSON.parse(l);
          if (m.method === 'notifications/cancelled') { const j = jobs.get(m.params.requestId); if (j) { clearInterval(j.tick); clearTimeout(j.done); } return; }
          if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's' } } });
          if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'fetch_all', inputSchema: { type: 'object' } }] } });
          if (m.method === 'tools/call') {
            const token = m.params._meta?.progressToken;
            let n = 0;
            const tick = setInterval(() => send({ method: 'notifications/progress', params: { progressToken: token, progress: ++n } }), 200);
            const done = setTimeout(() => { clearInterval(tick); send({ id: m.id, result: { content: [{ type: 'text', text: 'fetched ' + n } ] } }); }, m.params.arguments.ms);
            jobs.set(m.id, { tick, done });
          }
        });`,
    });
    dirs.push(dir);
    r = await rig();
    await r.pm.install(dir);
    await r.pm.enable('slowpoke');
    const ok = await callTool(r.rt, 'slowpoke__fetch_all', { ms: 6000 });
    expect(ok).toMatchObject({ isError: false, content: expect.stringMatching(/^fetched \d+$/) });
    const capped = await callTool(r.rt, 'slowpoke__fetch_all', { ms: 12_000 });
    expect(capped).toMatchObject({ isError: true, content: expect.stringMatching(/did not finish tools\/call within 8 s/) });
  }, 60_000);

  it('a page call has no fixed limit of its own, and the shell can stop it by its callId', async () => {
    // Scaled down as above: timeout_seconds 4, progress every 0.2 s.
    const dir = await writePlugin({
      'manifest.json': manifest('pagepoke'),
      'mcp/srv.json': { runtime: 'node', entry: 'srv.js', timeout_seconds: 4 },
      'srv.js': `import { createInterface } from 'node:readline';
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
        const jobs = new Map();
        const cancelled = [];
        createInterface({ input: process.stdin }).on('line', (l) => {
          const m = JSON.parse(l);
          if (m.method === 'notifications/cancelled') { cancelled.push(m.params.requestId); const j = jobs.get(m.params.requestId); if (j) { clearInterval(j.tick); clearTimeout(j.done); } return; }
          if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's' } } });
          if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'fetch_all', inputSchema: { type: 'object' } }, { name: 'cancelled', inputSchema: { type: 'object' } }] } });
          if (m.method === 'tools/call' && m.params.name === 'cancelled') return send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(cancelled) }] } });
          if (m.method === 'tools/call') {
            const token = m.params._meta?.progressToken;
            let n = 0;
            const tick = setInterval(() => send({ method: 'notifications/progress', params: { progressToken: token, progress: ++n } }), 200);
            const done = setTimeout(() => { clearInterval(tick); send({ id: m.id, result: { content: [{ type: 'text', text: '{"fetched":' + n + '}' } ] } }); }, m.params.arguments.ms);
            jobs.set(m.id, { tick, done });
          }
        });`,
      'views/main.json': { title: 'Main', entry: 'ui/index.html' },
      'ui/index.html': '<!doctype html><title>x</title>',
    });
    dirs.push(dir);
    r = await rig();
    await r.pm.install(dir);
    await r.pm.enable('pagepoke');
    const methods = pluginMethods(r.pm);
    // longer than timeout_seconds, kept alive by progress
    const ok = (await methods.pluginViewCall!({ plugin: 'pagepoke', view: 'main', tool: 'fetch_all', args: { ms: 6000 }, callId: 'page-1' })) as { isError: boolean; data?: { fetched: number } };
    expect(ok).toMatchObject({ isError: false, data: { fetched: expect.any(Number) } });
    expect(methods.pluginViewCancel!({ callId: 'page-1' })).toBe(false); // finished: nothing left to stop
    // the page goes away: the shell stops the call and the server is told
    const running = methods.pluginViewCall!({ plugin: 'pagepoke', view: 'main', tool: 'fetch_all', args: { ms: 20_000 }, callId: 'page-2' }) as Promise<{ isError: boolean }>;
    await new Promise((res) => setTimeout(res, 500));
    expect(methods.pluginViewCancel!({ callId: 'page-2' })).toBe(true);
    expect(await running).toMatchObject({ isError: true });
    const cancelled = (await r.pm.viewCall('pagepoke', 'main', 'cancelled')) as { data?: unknown[] };
    expect(cancelled.data).toHaveLength(1);
  }, 60_000);

  it('a plugin declaring concurrency: 1 gets its calls one after another; waiting calls end when it is disabled', async () => {
    const dir = await writePlugin({
      'manifest.json': manifest('solo'),
      'mcp/srv.json': { runtime: 'node', entry: 'srv.js', concurrency: 1, timeout_seconds: 2 },
      'srv.js': `import { createInterface } from 'node:readline';
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
        let busy = 0, most = 0;
        createInterface({ input: process.stdin }).on('line', (l) => {
          const m = JSON.parse(l);
          if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's' } } });
          if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'use_device', inputSchema: { type: 'object' } }] } });
          if (m.method === 'tools/call') {
            busy++; most = Math.max(most, busy);
            setTimeout(() => { busy--; send({ id: m.id, result: { content: [{ type: 'text', text: 'most ' + most } ] } }); }, m.params.arguments.ms);
          }
        });`,
    });
    dirs.push(dir);
    r = await rig();
    await r.pm.install(dir);
    await r.pm.enable('solo');
    // three calls of 1.2 s: the last waits 2.4 s, longer than timeout_seconds
    const results = await Promise.all([1, 2, 3].map(() => callTool(r!.rt, 'solo__use_device', { ms: 1200 })));
    expect(results.map((x) => x.content)).toEqual(['most 1', 'most 1', 'most 1']);
    // disabled while one runs and one waits: both end with an error, nothing hangs
    const running = callTool(r.rt, 'solo__use_device', { ms: 3000 });
    const waiting = callTool(r.rt, 'solo__use_device', { ms: 100 });
    await new Promise((res) => setTimeout(res, 300));
    await r.pm.disable('solo');
    expect(await running).toMatchObject({ isError: true });
    expect(await waiting).toMatchObject({ isError: true });
  }, 60_000);

  it('concurrency must be a whole number of 1 or more', async () => {
    const dir = await writePlugin({ 'manifest.json': manifest('badconc'), 'mcp/srv.json': { runtime: 'node', entry: 'srv.js', concurrency: 0.5 }, 'srv.js': '' });
    dirs.push(dir);
    expect(JSON.stringify((await readPluginFolder(dir)).issues)).toContain('concurrency');
  });

  it('max_call_seconds must be a positive number of seconds', async () => {
    const dir = await writePlugin({ 'manifest.json': manifest('badcap'), 'mcp/srv.json': { runtime: 'node', entry: 'srv.js', max_call_seconds: 0 }, 'srv.js': '' });
    dirs.push(dir);
    const folder = await readPluginFolder(dir);
    expect(JSON.stringify(folder.issues)).toContain('max_call_seconds');
  });

  it('the core, the plugin manager and the author kit pass the same host variables', async () => {
    const { DEFAULT_CHILD_ENV } = await import('../../core/src/util.ts');
    const kitFile = new URL('../../../skills/spica-plugin-author/scripts/lib/mcp.mjs', import.meta.url).href;
    const kit = (await import(kitFile)) as { PLUGIN_INHERIT_ENV: string[] };
    const { PLUGIN_INHERIT_ENV } = await import('./manager.ts');
    expect([...PLUGIN_INHERIT_ENV]).toEqual([...DEFAULT_CHILD_ENV]);
    expect(kit.PLUGIN_INHERIT_ENV).toEqual([...DEFAULT_CHILD_ENV]);
    expect(DEFAULT_CHILD_ENV).toEqual(expect.arrayContaining(['COMPUTERNAME', 'USERNAME']));
  });

  it('a server that cannot start fails the enable with a clear message', async () => {
    const dir = await writePlugin({
      'manifest.json': manifest('nostart'),
      'mcp/srv.json': { runtime: 'node', entry: 'srv.js' },
      'srv.js': 'process.exit(1);',
    });
    dirs.push(dir);
    r = await rig();
    await r.pm.install(dir);
    await expect(r.pm.enable('nostart')).rejects.toThrow(/「nostart」启用失败：进程 srv 启动失败/);
    expect(r.pm.describe('nostart').enabled).toBe(false);
  });

  it('a plugin with manifest errors is refused at install, with every problem listed', async () => {
    const dir = await writePlugin({ 'manifest.json': { manifest_version: 1, name: 'X' } });
    dirs.push(dir);
    r = await rig();
    await expect(r.pm.install(dir)).rejects.toThrow(/插件有错误，未安装：[\s\S]*name[\s\S]*version[\s\S]*description/);
  });

  it('a plugin for a newer Spica is refused', async () => {
    const dir = await writePlugin({ 'manifest.json': manifest('future', { compatibility: { spica: '>=9.0.0' } }) });
    dirs.push(dir);
    r = await rig();
    await expect(r.pm.install(dir)).rejects.toThrow(/要求 Spica >=9\.0\.0，当前是 0\.1\.0/);
  });
});
