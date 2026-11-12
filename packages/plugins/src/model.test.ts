// Plugins using the user's models (MCP sampling): only plugins whose manifest
// asks for it (permissions.model) are offered it, with the lower of the
// manifest's and the user's daily limit; the plugin page sees what each spent.
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
  return { gw, rt, pm, launches };
}

describe('plugins using the user\'s models', () => {
  it('the example plugin summarizes a note with the user\'s model; the limit and today\'s spend show on the plugin page', async () => {
    const { gw, rt, pm, launches } = await setup();
    await pm.install(EXAMPLE_PLUGIN);
    await pm.enable('notes');
    expect(launches.at(-1)?.sampling).toEqual({ pluginId: 'notes', maxUsdPerDay: 0.1 });

    await callTool(rt, 'notes__write_note', { title: 'Meeting', text: 'We met. We decided things. We will meet again.' });
    const r = await callTool(rt, 'notes__summarize_note', { title: 'Meeting' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/^Two lines about the meeting\.\n\n\(model: fake-model\)$/);
    // The model got the plugin's own system prompt and the note, and no tools.
    const req = JSON.stringify(gw.requests.at(-1)?.body ?? {});
    expect(req).toContain('You summarize notes.');
    expect(req).toContain('We decided things.');
    expect((gw.requests.at(-1)?.body as { tools?: unknown[] }).tools ?? []).toEqual([]);

    const use = pm.describe('notes').model!;
    expect(use).toMatchObject({ reason: 'Summarize a note when you ask (summarize_note).', maxUsdPerDay: 0.1, declaredMaxUsdPerDay: 0.1 });
    expect(typeof use.spentTodayUsd).toBe('number');
    // the fake gateway's model has no price: nothing is counted, the page is told (「今日 未计价」)
    expect(use).toMatchObject({ spentTodayUsd: 0, unpricedToday: true });
    const methods = pluginMethods(pm);
    expect(await methods.pluginModelUsage!()).toEqual([expect.objectContaining({ plugin: 'notes', displayName: 'Notes (example)', enabled: true, maxUsdPerDay: 0.1 })]);

    // The user lowers the limit: the server restarts with it.
    const d = (await methods.pluginSetModelLimit!({ plugin: 'notes', maxUsdPerDay: 0.05 })) as { model: { maxUsdPerDay: number; userMaxUsdPerDay: number } };
    expect(d.model).toMatchObject({ maxUsdPerDay: 0.05, userMaxUsdPerDay: 0.05 });
    expect(launches.at(-1)?.sampling).toEqual({ pluginId: 'notes', maxUsdPerDay: 0.05 });
    // A user limit above the manifest's does not raise it.
    await pm.setModelLimit('notes', 3);
    expect(launches.at(-1)?.sampling).toEqual({ pluginId: 'notes', maxUsdPerDay: 0.1 });
    // 0 turns it off: the server is not offered the model at all.
    await pm.setModelLimit('notes', 0);
    expect(launches.at(-1)?.sampling).toBeUndefined();
    const off = await callTool(rt, 'notes__summarize_note', { title: 'Meeting' });
    expect(off).toMatchObject({ isError: true, content: 'This Spica does not let the plugin use a model.' });
    // Back to the manifest's limit; the choice is kept in state.json.
    await pm.setModelLimit('notes', null);
    expect(launches.at(-1)?.sampling).toEqual({ pluginId: 'notes', maxUsdPerDay: 0.1 });
    expect(JSON.parse(await readFile(join(pm.root, 'state.json'), 'utf8')).plugins.notes.modelMaxUsdPerDay).toBeUndefined();
  });

  it('a plugin that did not ask is not offered the model, and cannot be given a limit', async () => {
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
    await expect(pm.setModelLimit('notes', 1)).rejects.toThrow('「notes」未申请使用模型。');
  });

  it('manifest: permissions.model needs a reason; the daily limit is a positive number (default 0.5)', () => {
    const check = (model: unknown) => validateManifest({ ...(manifest('model-user') as Record<string, unknown>), permissions: { model } });
    expect(check({ reason: 'Summaries' }).manifest?.permissions.model).toEqual({ reason: 'Summaries', maxUsdPerDay: 0.5 });
    expect(check({ reason: 'Summaries', max_usd_per_day: 0.2 }).manifest?.permissions.model).toEqual({ reason: 'Summaries', maxUsdPerDay: 0.2 });
    expect(check({}).issues).toContainEqual(expect.objectContaining({ where: 'manifest.json · permissions.model.reason', severity: 'error' }));
    expect(check({ reason: 'x', max_usd_per_day: 0 }).issues).toContainEqual(expect.objectContaining({ where: 'manifest.json · permissions.model.max_usd_per_day', severity: 'error' }));
    expect(check({ reason: 'x', max_usd_per_day: 9 }).issues).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('偏高') }));
    expect(check(true).issues).toContainEqual(expect.objectContaining({ where: 'manifest.json · permissions.model', severity: 'error' }));
  });
});
