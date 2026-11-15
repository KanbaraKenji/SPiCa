// Plugins using the user's models (MCP sampling): only plugins whose manifest
// asks for it (permissions.model) are offered it, with no dollar limit; the
// user can allow or forbid each one on the plugin page.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Starts real plugin processes against a fake model service: slow on a busy machine.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { FakeGateway } from '../../core/src/testing/fake-gateway.ts';
import type { McpLaunch } from './host.ts';
import { runtimeHost } from './host.ts';
import { PluginManager } from './manager.ts';
import { validateManifest } from './manifest.ts';
import { pluginMethods } from './backend.ts';
import { EXAMPLE_PLUGIN, callTool, makeRuntime, manifest } from './testing/helpers.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});

async function setup() {
  const gw = await new FakeGateway().start();
  cleanups.push(() => gw.stop());
  gw.onRequest(() => ({ text: 'Two lines about the meeting.', usage: { input: 50, output: 8 } }));
  const rt = makeRuntime(`${gw.baseUrl}/v1`);
  cleanups.push(() => rt.close());
  const launches: McpLaunch[] = [];
  const base = runtimeHost(rt);
  const host = { ...base, connectMcp: (c: McpLaunch, s: string) => (launches.push(c), base.connectMcp(c, s)) };
  const root = await mkdtemp(join(tmpdir(), 'spica-plugins-'));
  const pm = new PluginManager({ host, root });
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  cleanups.push(() => pm.shutdown());
  /** Stop the running manager, change its state.json, and start a new one on the same folder (as after a restart). */
  let current = pm;
  const restart = async (edit: (state: { plugins: Record<string, Record<string, unknown>> }) => void) => {
    await current.shutdown();
    const file = join(root, 'state.json');
    const state = JSON.parse(await readFile(file, 'utf8'));
    edit(state);
    await writeFile(file, JSON.stringify(state));
    const next = new PluginManager({ host, root });
    cleanups.push(() => next.shutdown());
    await next.load();
    current = next;
    return next;
  };
  return { gw, rt, pm, launches, restart };
}

describe("plugins using the user's models", () => {
  it("the example plugin summarizes a note with the user's model; the user can forbid it and allow it again", async () => {
    const { gw, rt, pm, launches } = await setup();
    await pm.install(EXAMPLE_PLUGIN);
    await pm.enable('notes');
    // allowed by default, with no dollar limit
    expect(launches.at(-1)?.sampling).toEqual({ pluginId: 'notes' });

    await callTool(rt, 'notes__write_note', { title: 'Meeting', text: 'We met. We decided things. We will meet again.' });
    const r = await callTool(rt, 'notes__summarize_note', { title: 'Meeting' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/^Two lines about the meeting\.\n\n\(model: fake-model\)$/);
    // The model got the plugin's own system prompt and the note, and no tools.
    const req = JSON.stringify(gw.requests.at(-1)?.body ?? {});
    expect(req).toContain('You summarize notes.');
    expect(req).toContain('We decided things.');
    expect((gw.requests.at(-1)?.body as { tools?: unknown[] }).tools ?? []).toEqual([]);

    expect(pm.describe('notes').model).toEqual({ reason: 'Summarize a note when you ask (summarize_note).', allowed: true });
    const methods = pluginMethods(pm);
    expect(await methods.pluginModelUsage!()).toEqual([
      { plugin: 'notes', displayName: 'Notes (example)', enabled: true, reason: 'Summarize a note when you ask (summarize_note).', allowed: true },
    ]);

    // Forbidden: the server restarts and is not offered the model at all.
    const d = (await methods.pluginSetModelAllowed!({ plugin: 'notes', allowed: false })) as { model: { allowed: boolean } };
    expect(d.model).toMatchObject({ allowed: false });
    expect(launches.at(-1)?.sampling).toBeUndefined();
    const off = await callTool(rt, 'notes__summarize_note', { title: 'Meeting' });
    expect(off).toMatchObject({ isError: true, content: 'This Spica does not let the plugin use a model.' });
    expect(JSON.parse(await readFile(join(pm.root, 'state.json'), 'utf8')).plugins.notes.modelAllowed).toBe(false);
    // Only true or false.
    await expect(Promise.resolve().then(() => methods.pluginSetModelAllowed!({ plugin: 'notes', allowed: 'false' }))).rejects.toThrow('allowed 须为 true 或 false。');
    // Allowed again.
    await pm.setModelAllowed('notes', true);
    expect(launches.at(-1)?.sampling).toEqual({ pluginId: 'notes' });
    expect(JSON.parse(await readFile(join(pm.root, 'state.json'), 'utf8')).plugins.notes.modelAllowed).toBe(true);
  });

  it('older saved daily limits: 0 reads as forbidden, any other value as allowed; allowing after an old 0 is kept', async () => {
    const { pm, launches, restart } = await setup();
    await pm.install(EXAMPLE_PLUGIN);
    await pm.enable('notes');

    const forbidden = await restart((s) => (s.plugins.notes!.modelMaxUsdPerDay = 0));
    expect(forbidden.describe('notes').model).toMatchObject({ allowed: false });
    expect(launches.at(-1)?.sampling).toBeUndefined();
    // allowing replaces the old field with the new one, and survives a restart
    await forbidden.setModelAllowed('notes', true);
    const state = JSON.parse(await readFile(join(forbidden.root, 'state.json'), 'utf8')).plugins.notes;
    expect(state).toMatchObject({ modelAllowed: true });
    expect(state.modelMaxUsdPerDay).toBeUndefined();
    const again = await restart(() => undefined);
    expect(again.describe('notes').model).toMatchObject({ allowed: true });
    expect(launches.at(-1)?.sampling).toEqual({ pluginId: 'notes' });

    // an old non-zero limit: allowed, and the amount plays no part
    const limited = await restart((s) => {
      delete s.plugins.notes!.modelAllowed;
      s.plugins.notes!.modelMaxUsdPerDay = 0.05;
    });
    expect(limited.describe('notes').model).toMatchObject({ allowed: true });
    expect(launches.at(-1)?.sampling).toEqual({ pluginId: 'notes' });
  });

  it('a forbid stays when the plugin is installed again (an update)', async () => {
    const { pm, launches } = await setup();
    await pm.install(EXAMPLE_PLUGIN);
    await pm.enable('notes');
    await pm.setModelAllowed('notes', false);
    await pm.install(EXAMPLE_PLUGIN);
    expect(pm.describe('notes').model).toMatchObject({ allowed: false });
    expect(launches.at(-1)?.sampling).toBeUndefined();
  });

  it('a plugin that did not ask is not offered the model, and cannot be allowed', async () => {
    const { rt, pm, launches } = await setup();
    const dir = await mkdtemp(join(tmpdir(), 'spica-src-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await cp(EXAMPLE_PLUGIN, dir, { recursive: true });
    const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    delete m.permissions.model;
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(m));
    await pm.install(dir);
    await pm.enable('notes');
    expect(launches.every((l) => l.sampling === undefined)).toBe(true);
    expect(pm.describe('notes').model).toBeUndefined();
    await callTool(rt, 'notes__write_note', { title: 'Meeting', text: 'text' });
    expect((await callTool(rt, 'notes__summarize_note', { title: 'Meeting' })).content).toBe('This Spica does not let the plugin use a model.');
    await expect(pm.setModelAllowed('notes', true)).rejects.toThrow('「notes」未申请使用模型。');
  });

  it('manifest: permissions.model needs a reason only; an older max_usd_per_day still loads and is ignored', () => {
    const check = (model: unknown) => validateManifest({ ...(manifest('model-user') as Record<string, unknown>), permissions: { model } });
    expect(check({ reason: 'Summaries' }).issues).toEqual([]);
    expect(check({ reason: 'Summaries' }).manifest?.permissions.model).toEqual({ reason: 'Summaries' });
    for (const old of [0.2, 0, 9, 'lots']) {
      const r = check({ reason: 'Summaries', max_usd_per_day: old });
      expect(r.manifest?.permissions.model).toEqual({ reason: 'Summaries' });
      expect(r.issues).toEqual([]);
    }
    expect(check({}).issues).toContainEqual(expect.objectContaining({ where: 'manifest.json · permissions.model.reason', severity: 'error' }));
    expect(check({ reason: 'x', other: 1 }).issues).toContainEqual(expect.objectContaining({ where: 'manifest.json · permissions.model.other', severity: 'warning' }));
    expect(check(true).issues).toContainEqual(expect.objectContaining({ where: 'manifest.json · permissions.model', severity: 'error' }));
  });
});
