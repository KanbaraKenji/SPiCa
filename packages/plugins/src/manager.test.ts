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
import { runtimeHost } from './host.ts';
import { EXAMPLE_PLUGIN, OUTLOOK_PLUGIN, callTool, hookCtx, makeRuntime, manifest, rig, toolNames, until, writePlugin, type Rig } from './testing/helpers.ts';

let r: Rig | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await r?.cleanup();
  r = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const NOTES_TOOLS = ['notes__list_notes', 'notes__read_note', 'notes__write_note', 'notes__delete_note', 'notes__search_catalog'];

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
    expect(text).toMatch(/views\/a\.json: entry 要写插件文件夹里的相对路径/);
    expect(text).toMatch(/views\/b\.json: 视图的 placement 只能是 sidebar 或 panel/);
    expect(text).toMatch(/views\/c\.json: entry 指向的 ui\/missing\.html 不存在/);
    expect(text).toMatch(/views\/d\.json: permissions\.tools 是本插件工具的原名列表/);
    expect(text).toMatch(/views\/e\.json: icon 要指向 \.svg 文件/);
    expect(text).toMatch(/views\/f\.json: 视图声明不是合法的 JSON/);
    expect(check.views).toEqual([]);
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
    expect(d.servers[0]).toMatchObject({ status: 'failed', restarts: 2, lastError: expect.stringContaining('崩溃了 3 次') });
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
    process.env.PLUGIN_TEST_PLAIN = 'x';
    process.env.PLUGIN_TEST_API_KEY = 'secret';
    try {
      r = await rig();
      await r.pm.install(dir);
      await r.pm.enable('envy');
      const names = (await callTool(r.rt, 'envy__env', {})).content.split(',');
      expect(names).toEqual(expect.arrayContaining(['OWN_SETTING', 'SPICA_PLUGIN_DATA', 'SPICA_MOCK']));
      expect(names.some((n) => n.toUpperCase() === 'PATH')).toBe(true);
      expect(names).not.toContain('PLUGIN_TEST_PLAIN');
      expect(names).not.toContain('PLUGIN_TEST_API_KEY');
    } finally {
      delete process.env.PLUGIN_TEST_PLAIN;
      delete process.env.PLUGIN_TEST_API_KEY;
    }
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
    await expect(r.pm.enable('nostart')).rejects.toThrow(/「nostart」启用失败：进程 srv 没能启动/);
    expect(r.pm.describe('nostart').enabled).toBe(false);
  });

  it('a plugin with manifest errors is refused at install, with every problem listed', async () => {
    const dir = await writePlugin({ 'manifest.json': { manifest_version: 1, name: 'X' } });
    dirs.push(dir);
    r = await rig();
    await expect(r.pm.install(dir)).rejects.toThrow(/没有装上：[\s\S]*name[\s\S]*version[\s\S]*description/);
  });

  it('a plugin for a newer Spica is refused', async () => {
    const dir = await writePlugin({ 'manifest.json': manifest('future', { compatibility: { spica: '>=9.0.0' } }) });
    dirs.push(dir);
    r = await rig();
    await expect(r.pm.install(dir)).rejects.toThrow(/要求 Spica >=9\.0\.0，当前是 0\.1\.0/);
  });
});
