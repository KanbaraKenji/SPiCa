// Workflow files and role templates.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkflows, validateWorkflow } from './projects.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway, tempDir } from './testing/helpers.ts';

const exampleDir = fileURLToPath(new URL('../examples/workflows/', import.meta.url));

describe('workflow files', () => {
  it('loads the shipped example', () => {
    const { workflows, errors } = loadWorkflows(exampleDir);
    expect(errors).toEqual([]);
    const w = workflows.get('product-development')!;
    expect(w.stages.map((s) => s.id)).toEqual(['sample', 'pilot', 'mass']);
    expect(w.objectLevels).toEqual([
      { id: 'product', name: 'Product' },
      { id: 'part', name: 'Part', parent: 'product' },
    ]);
  });

  it('reports broken files by name and keeps loading the others', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'a-good.json'), JSON.stringify({ id: 'ok', name: 'OK', stages: [{ id: 's1' }] }));
      await writeFile(join(dir, 'b-bad-json.json'), '{ nope');
      await writeFile(join(dir, 'c-no-stages.json'), JSON.stringify({ id: 'x', name: 'X', stages: [] }));
      await writeFile(join(dir, 'd-dup.json'), JSON.stringify({ id: 'ok', name: 'again', stages: [{ id: 's' }] }));
      await writeFile(join(dir, 'notes.txt'), 'ignored');
      const { workflows, errors } = loadWorkflows(dir);
      expect([...workflows.keys()]).toEqual(['ok']);
      expect(workflows.get('ok')!.stages[0]).toEqual({ id: 's1', name: 's1' });
      expect(errors).toHaveLength(3);
      expect(errors.join('\n')).toMatch(/b-bad-json\.json: not valid JSON/);
      expect(errors.join('\n')).toMatch(/c-no-stages\.json: "stages" must be a non-empty array/);
      expect(errors.join('\n')).toMatch(/d-dup\.json: id "ok" is already defined/);
    } finally {
      await cleanup();
    }
  });

  it('rejects duplicate stages, unknown parents and cycles in object levels', () => {
    const base = { id: 'w', name: 'W' };
    expect(() => validateWorkflow({ ...base, stages: [{ id: 'a' }, { id: 'a' }] }, 't')).toThrow(/used twice/);
    expect(() => validateWorkflow({ ...base, stages: [{ id: 'a' }], objectLevels: [{ id: 'x', parent: 'nope' }] }, 't')).toThrow(/unknown parent/);
    expect(() =>
      validateWorkflow({ ...base, stages: [{ id: 'a' }], objectLevels: [{ id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }] }, 't'),
    ).toThrow(/cycle/);
  });

  it('a missing folder is an error, not a crash', () => {
    const { workflows, errors } = loadWorkflows(join(exampleDir, 'does-not-exist'));
    expect(workflows.size).toBe(0);
    expect(errors[0]).toMatch(/workflows folder/);
  });
});

describe('role templates', () => {
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = await startGateway();
  });
  afterEach(async () => {
    await gw.stop();
  });

  it('apply system prompt, role and tools; explicit fields win; deployment templates override', async () => {
    const rt = makeRuntime(gw, { templates: [{ id: 'project-manager', name: 'PM (custom)', role: 'manager', system: 'CUSTOM PM PROMPT', tools: ['read_file'] }] });
    const top = rt.createSession({ templateId: 'top' });
    expect(top.info()).toMatchObject({ role: 'top', templateId: 'top' });
    expect(top.config.system).toMatch(/top-level agent/);
    const pm = rt.createSession({ templateId: 'project-manager', parentId: top.id });
    expect(pm.config.system).toBe('CUSTOM PM PROMPT');
    expect(pm.config.tools).toEqual(['read_file']);
    expect(pm.info().role).toBe('manager');
    const explicit = rt.createSession({ templateId: 'top', system: 'MINE' });
    expect(explicit.config.system).toBe('MINE');
    expect(() => rt.createSession({ templateId: 'nope' })).toThrow(/unknown role template/);
  });

  it('sub-agents inherit the project of their parent', () => {
    const rt = makeRuntime(gw);
    const pm = rt.createSession({ templateId: 'project-manager', projectId: 'prj_1' });
    const worker = rt.createSession({ parentId: pm.id });
    expect(worker.info().projectId).toBe('prj_1');
    expect(rt.createSession().info().projectId).toBeUndefined();
  });
});

describe('projects', () => {
  let gw: FakeGateway;
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    gw = await startGateway();
    ({ dir, cleanup } = await tempDir());
  });
  afterEach(async () => {
    await gw.stop();
    await cleanup();
  });
  const rtFor = (extra: Parameters<typeof makeRuntime>[1] = {}) => makeRuntime(gw, { cwd: dir, workflowsDir: exampleDir, ...extra });

  it('a project is a folder plus a manager under the single top-level agent', async () => {
    gw.onRequest(() => ({ text: 'on it' }));
    const rt = rtFor();
    const events: string[] = [];
    rt.events.on((e) => events.push(e.type));
    const p = rt.createProject({ name: 'Orion: relaunch?', workflowId: 'product-development', brief: 'BRIEF-TEXT start with samples' });
    expect(p.folder).toBe(join(dir, 'Orion_ relaunch_'));
    expect(p.stage).toBe('sample');
    const { stat } = await import('node:fs/promises');
    expect((await stat(p.folder)).isDirectory()).toBe(true);
    const top = rt.top();
    expect(rt.top().id).toBe(top.id); // one top-level agent
    const pm = rt.session(p.managerSessionId)!;
    expect(pm.info()).toMatchObject({ role: 'manager', templateId: 'project-manager', parentId: top.id, projectId: p.id, cwd: p.folder, title: 'Orion: relaunch?' });
    expect(events).toContain('project.created');
    await pm.idle();
    expect(JSON.stringify(gw.requests[0]!.body.messages)).toContain('BRIEF-TEXT');
    expect(rt.listProjects().map((x) => x.id)).toEqual([p.id]);
    expect(rt.getProject(p.id)).toMatchObject({ workflow: { id: 'product-development' }, manager: { id: pm.id }, agents: [] });
    expect(() => rt.createProject({ name: 'x', workflowId: 'nope' })).toThrow(/unknown workflow "nope"/);
  });

  it('stage changes are checked against the workflow, logged and relayed to the top-level agent', () => {
    const rt = rtFor();
    const p = rt.createProject({ name: 'P', workflowId: 'product-development' });
    expect(() => rt.setStage(p.id, 'launch', undefined, p.managerSessionId)).toThrow(/unknown stage "launch"/);
    const u = rt.setStage(p.id, 'pilot', 'samples approved', p.managerSessionId);
    expect(u.stage).toBe('pilot');
    expect(rt.getProject(p.id)!.recentLog[0]).toMatchObject({ kind: 'stage', summary: 'Stage changed to "Pilot run": samples approved' });
    const topNotes = rt.top().messages().filter((m) => m.kind === 'relay');
    expect(topNotes[0]!.meta).toMatchObject({ kind: 'decision', text: 'Project "P": Stage changed to "Pilot run": samples approved' });
  });

  it('work objects follow the levels in the workflow file', () => {
    const rt = rtFor();
    const p = rt.createProject({ name: 'P', workflowId: 'product-development' });
    const product = rt.addWorkObject(p.id, { level: 'product', name: 'Charger X' });
    const part = rt.addWorkObject(p.id, { level: 'Part', name: 'Housing', parentId: product.id });
    expect(part).toMatchObject({ level: 'part', parentId: product.id });
    expect(() => rt.addWorkObject(p.id, { level: 'part', name: 'Orphan' })).toThrow(/belongs under a "product"/);
    expect(() => rt.addWorkObject(p.id, { level: 'part', name: 'Wrong', parentId: part.id })).toThrow(/not a "part"/);
    expect(() => rt.addWorkObject(p.id, { level: 'module', name: 'M' })).toThrow(/unknown level/);
    expect(rt.getProject(p.id)!.objects.map((o) => o.name)).toEqual(['Charger X', 'Housing']);
  });

  it('key actions of the manager and its sub-agents go to the project log', async () => {
    gw.enqueue({ toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'spec.md', content: '# Spec' } }] }, { text: 'written' });
    const rt = rtFor();
    const activity: unknown[] = [];
    rt.events.on((e) => e.type === 'project.activity' && activity.push(e.entry));
    const p = rt.createProject({ name: 'P' });
    const worker = rt.createSession({ parentId: p.managerSessionId, title: 'Writer' });
    await worker.send('write the spec', { author: 'parent' }).done;
    expect(rt.getProject(p.id)!.recentLog[0]).toMatchObject({ kind: 'file_write', path: 'spec.md', sessionId: worker.id, summary: 'Wrote spec.md' });
    expect(activity).toHaveLength(1);
    // sessions outside projects leave no project log
    gw.enqueue({ toolCalls: [{ id: 'w2', name: 'write_file', args: { path: 'other.md', content: 'x' } }] }, { text: 'ok' });
    await rt.createSession().send('write').done;
    expect(activity).toHaveLength(1);
  });

  it('projects survive a restart', async () => {
    const { SqliteStore } = await import('./store/sqlite.ts');
    const path = join(dir, 'spica.db');
    const rt1 = rtFor({ store: new SqliteStore(path) });
    const p = rt1.createProject({ name: 'Kept', workflowId: 'product-development' });
    rt1.setStage(p.id, 'mass', undefined, p.managerSessionId);
    rt1.addWorkObject(p.id, { level: 'product', name: 'Lamp' });
    const topId = rt1.top().id;
    await rt1.close();
    const rt2 = rtFor({ store: new SqliteStore(path) });
    rt2.restore();
    const d = rt2.getProject(p.id)!;
    expect(d).toMatchObject({ name: 'Kept', stage: 'mass', manager: { id: p.managerSessionId, projectId: p.id } });
    expect(d.objects.map((o) => o.name)).toEqual(['Lamp']);
    expect(rt2.top().id).toBe(topId);
    await rt2.close();
  });
});
