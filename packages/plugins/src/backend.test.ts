// The plugin commands as MCP service tools: J6 through the tool surface.
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachBackend } from './backend.ts';
import { EXAMPLE_PLUGIN, callTool, makeRuntime, toolNames } from './testing/helpers.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.setConfig({ testTimeout: 30_000 });

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe('plugin tools on the MCP service', () => {
  it('J6 through the tools: install, tools appear, disable, tools gone; state comes back after restart', async () => {
    const rt = makeRuntime();
    const root = await mkdtemp(join(tmpdir(), 'spica-backend-'));
    const ext = await attachBackend(rt, { root, endTree: false });
    cleanup = async () => {
      await ext.close();
      await rm(root, { recursive: true, force: true });
    };
    const tool = (n: string) => ext.mcpTools.find((t) => t.name === n)!;
    const listTools = async () => toolNames(rt);

    expect(await listTools()).toEqual([]);
    const d = (await tool('spica_plugin_install').run({ path: EXAMPLE_PLUGIN, enable: true })) as { enabled: boolean };
    expect(d.enabled).toBe(true);
    expect(await listTools()).toContain('notes__write_note');
    expect((await callTool(rt, 'notes__list_notes', {})).content).toContain('empty');
    expect(await tool('spica_plugins_list').run({})).toMatchObject({ mock: false, plugins: [{ name: 'notes', enabled: true }] });
    await tool('spica_plugin_disable').run({ name: 'notes' });
    expect(await listTools()).toEqual([]);
    await expect(tool('spica_plugin_enable').run({ name: 'nope' })).rejects.toThrow(/未安装插件「nope」/);
    await expect(tool('spica_plugin_install').run({ path: join(root, 'missing') })).rejects.toThrow(/找不到/);

    // Enabled again → a new backend on the same root brings it back.
    await tool('spica_plugin_enable').run({ name: 'notes' });
    await ext.close();
    const rt2 = makeRuntime();
    const ext2 = await attachBackend(rt2, { root, mock: true, endTree: false });
    cleanup = async () => {
      await ext2.close();
      await rm(root, { recursive: true, force: true });
    };
    expect(toolNames(rt2)).toContain('notes__search_catalog');
    expect(await ext2.methods.pluginsMock!()).toBe(true);
    expect(((await ext2.methods.pluginsList!()) as { name: string }[]).map((p) => p.name)).toEqual(['notes']);
    expect((await callTool(rt2, 'notes__search_catalog', { query: 'stars' })).content).toContain('Counting Stars');
  });

  it('page methods for the shell: list pages, resolve files, call tools through the real runtime', async () => {
    const rt = makeRuntime();
    const root = await mkdtemp(join(tmpdir(), 'spica-backend-'));
    const ext = await attachBackend(rt, { root, endTree: false });
    cleanup = async () => {
      await ext.close();
      await rm(root, { recursive: true, force: true });
    };
    const m = ext.methods;
    await ext.mcpTools.find((t) => t.name === 'spica_plugin_install')!.run({ path: EXAMPLE_PLUGIN, enable: true });
    expect(await m.pluginViews!()).toMatchObject([
      { plugin: 'notes', id: 'notebook', entry: 'ui/index.html', placement: 'sidebar' },
      { plugin: 'notes', id: 'quick-note', entry: 'ui/quick-note.html', placement: 'panel' },
      { plugin: 'notes', id: 'settings', entry: 'ui/settings.html', placement: 'settings' },
    ]);
    expect(await m.pluginViewFile!({ plugin: 'notes', path: 'ui/index.html' })).toMatch(/[\\/]ui[\\/]index\.html$/);
    expect(await m.pluginViewFile!({ plugin: 'notes', path: '../state.json' })).toBeNull();
    expect(await m.pluginViewCall!({ plugin: 'notes', view: 'notebook', tool: 'write_note', args: { title: 'a', text: 'b' } })).toMatchObject({ isError: false });
    expect(await m.pluginViewCall!({ plugin: 'notes', view: 'notebook', tool: 'delete_note', args: { title: 'a' } })).toMatchObject({ content: expect.stringMatching(/^\[CONFIRM_REQUIRED\]/) });
    expect(await m.pluginViewCall!({ plugin: 'notes', view: 'notebook', tool: 'delete_note', args: { title: 'a' }, confirmed: true })).toMatchObject({ isError: false });
  });
});
