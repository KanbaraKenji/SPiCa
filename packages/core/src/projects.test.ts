// Workflow files and role templates.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkflows, validateWorkflow } from './projects.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway, tempDir } from './testing/helpers.ts';

// gateways, child processes and local servers start slowly when several full runs share the machine
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
    const pm = rt.session(p.managerSessionId)!;
    // a standing session of its own: no conversation is its parent
    expect(pm.info()).toMatchObject({ role: 'manager', templateId: 'project-manager', parentId: null, projectId: p.id, cwd: p.folder, title: 'Orion: relaunch?' });
    expect(events).toContain('project.created');
    await pm.idle();
    expect(JSON.stringify(gw.requests[0]!.body.messages)).toContain('BRIEF-TEXT');
    expect(rt.listProjects().map((x) => x.id)).toEqual([p.id]);
    expect(rt.getProject(p.id)).toMatchObject({ workflow: { id: 'product-development' }, manager: { id: pm.id }, agents: [] });
    expect(() => rt.createProject({ name: 'x', workflowId: 'nope' })).toThrow(/unknown workflow "nope"/);
  });

  it('stage changes are checked against the workflow and logged in the project (no conversation gets a note)', () => {
    const rt = rtFor();
    const p = rt.createProject({ name: 'P', workflowId: 'product-development' });
    expect(() => rt.setStage(p.id, 'launch', undefined, p.managerSessionId)).toThrow(/unknown stage "launch"/);
    const u = rt.setStage(p.id, 'pilot', 'samples approved', p.managerSessionId);
    expect(u.stage).toBe('pilot');
    expect(rt.getProject(p.id)!.recentLog[0]).toMatchObject({ action: 'stage', target: 'pilot', detail: 'samples approved', summary: 'Stage changed to "Pilot run": samples approved' });
    expect(rt.sessions().some((s) => s.messages().some((m) => m.kind === 'relay'))).toBe(false);
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
    const log = rt.getProject(p.id)!.recentLog;
    expect(log.find((e) => e.action === 'file.write')).toMatchObject({ target: 'spec.md', sessionId: worker.id });
    expect(log.find((e) => e.action === 'child.spawn')).toMatchObject({ target: 'Writer', detail: worker.id, sessionId: p.managerSessionId });
    expect(log.find((e) => e.action === 'child.report')).toMatchObject({ target: 'Writer', detail: 'written' });
    expect(activity).toHaveLength(3);
    // sessions outside projects leave no project log
    gw.enqueue({ toolCalls: [{ id: 'w2', name: 'write_file', args: { path: 'other.md', content: 'x' } }] }, { text: 'ok' });
    await rt.createSession().send('write').done;
    expect(activity).toHaveLength(3);
  });

  it('a sub-task the manager sent out keeps its record after a restart: what it was asked, its calls and results, its report', async () => {
    const { SqliteStore } = await import('./store/sqlite.ts');
    const path = join(dir, 'spica.db');
    gw.enqueue({ toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'quote.txt' } }] }, { text: 'price is 2.35' });
    const rt1 = rtFor({ store: new SqliteStore(path) });
    const p = rt1.createProject({ name: 'Part T1' });
    await mkdir(p.folder, { recursive: true });
    await writeFile(join(p.folder, 'quote.txt'), 'unit price 2.35');
    const worker = rt1.createSession({ parentId: p.managerSessionId, title: 'Quotes' });
    await worker.send('find the price', { author: 'parent' }).done;
    await rt1.close();
    const rt2 = rtFor({ store: new SqliteStore(path) });
    rt2.restore();
    const again = rt2.session(worker.id)!;
    expect(again.info()).toMatchObject({ parentId: p.managerSessionId, role: 'worker', status: 'done', title: 'Quotes' });
    const kept = again.messages();
    expect(kept.find((m) => m.kind === 'user')?.content).toEqual([expect.objectContaining({ text: 'find the price' })]);
    expect(kept.flatMap((m) => m.content).find((b) => b.type === 'tool_use')).toMatchObject({ name: 'read_file', input: { path: 'quote.txt' } });
    expect(JSON.stringify(kept.flatMap((m) => m.content).find((b) => b.type === 'tool_result'))).toContain('unit price 2.35');
    expect(kept.at(-1)?.content).toEqual([expect.objectContaining({ text: 'price is 2.35' })]);
    await rt2.close();
  });

  it('a sub-task kept for later jobs (spawn_agent resident) reports, then waits idle, and is still that after a restart', async () => {
    const { SqliteStore } = await import('./store/sqlite.ts');
    const path = join(dir, 'spica.db');
    gw.onRequest((req) => {
      const all = JSON.stringify(req.body.messages);
      if (all.includes('PM-GO') && !all.includes('Started sub-agent')) {
        return { toolCalls: [{ id: 's1', name: 'spawn_agent', args: { title: 'Samples', task: 'FOLLOW-UP the samples', resident: true } }, { id: 's2', name: 'spawn_agent', args: { title: 'Once', task: 'ONE-OFF job' } }] };
      }
      if (all.includes('FOLLOW-UP') || all.includes('ONE-OFF')) return { text: 'reported' };
      return { text: 'ok' };
    });
    const rt1 = rtFor({ store: new SqliteStore(path) });
    const p = rt1.createProject({ name: 'Part T1' });
    const pm = rt1.session(p.managerSessionId)!;
    await pm.send('PM-GO').done;
    const kids = rt1.children(pm.id);
    await Promise.all(kids.map((k) => k.idle()));
    const kept = kids.find((k) => k.info().title === 'Samples')!;
    const once = kids.find((k) => k.info().title === 'Once')!;
    expect(kept.info()).toMatchObject({ resident: true, status: 'idle' });
    expect(once.info()).toMatchObject({ status: 'done' });
    expect(once.info()).not.toHaveProperty('resident');
    // told in its instructions, not in the task the user reads
    expect(JSON.stringify(kept.messages()[0]?.content)).not.toContain('kept for later');
    const keptRequest = gw.requests.find((q) => JSON.stringify(q.body.messages).includes('FOLLOW-UP'))!;
    expect((keptRequest.body.messages as { content: string }[])[0]!.content).toContain('You are kept for later jobs');
    // its report reached the manager as any sub-agent's does
    expect(rt1.lastReport(kept.id)).toBe('reported');
    await rt1.close();
    const rt2 = rtFor({ store: new SqliteStore(path) });
    rt2.restore();
    expect(rt2.session(kept.id)!.info()).toMatchObject({ resident: true, status: 'idle' });
    await rt2.close();
  });

  it('a sub-task kept for later jobs is ended by stopping it (the user, or its manager with stop_agent), and stays ended after a restart', async () => {
    const { SqliteStore } = await import('./store/sqlite.ts');
    const path = join(dir, 'spica.db');
    gw.onRequest((req) => {
      const all = JSON.stringify(req.body.messages);
      if (all.includes('PM-GO') && !all.includes('Started sub-agent')) {
        return { toolCalls: [{ id: 's1', name: 'spawn_agent', args: { title: 'A', task: 'JOB-A', resident: true } }, { id: 's2', name: 'spawn_agent', args: { title: 'B', task: 'JOB-B', resident: true } }] };
      }
      if (all.includes('PM-END') && !all.includes('Stopped sub-agent')) {
        const b = all.match(/B\\*" with id (ses_[A-Za-z0-9_-]+)/)?.[1] ?? 'none';
        return { toolCalls: [{ id: 'x1', name: 'stop_agent', args: { id: b } }, { id: 'x2', name: 'stop_agent', args: { id: 'ses_nope' } }] };
      }
      return { text: 'ok' };
    });
    const rt1 = rtFor({ store: new SqliteStore(path) });
    const p = rt1.createProject({ name: 'Part T1' });
    const pm = rt1.session(p.managerSessionId)!;
    await pm.send('PM-GO').done;
    const kids = rt1.children(pm.id);
    await Promise.all(kids.map((k) => k.idle()));
    const a = kids.find((k) => k.info().title === 'A')!;
    const b = kids.find((k) => k.info().title === 'B')!;
    expect(a.info()).toMatchObject({ resident: true, status: 'idle' });
    // the user presses 停止 on the idle one: ended
    a.abort();
    expect(a.info()).toMatchObject({ status: 'aborted' });
    expect(a.info()).not.toHaveProperty('resident');
    // its manager ends the other one; someone else's id is refused
    await pm.send('PM-END').done;
    expect(b.info()).toMatchObject({ status: 'aborted' });
    expect(b.info()).not.toHaveProperty('resident');
    const refused = pm.messages().flatMap((m) => m.content).find((x) => x.type === 'tool_result' && x.toolUseId === 'x2');
    expect(refused && 'content' in refused ? refused.content : '').toContain('not one of your sub-agents');
    await rt1.close();
    const rt2 = rtFor({ store: new SqliteStore(path) });
    rt2.restore();
    for (const id of [a.id, b.id]) {
      expect(rt2.session(id)!.info()).toMatchObject({ status: 'aborted' });
      expect(rt2.session(id)!.info()).not.toHaveProperty('resident');
    }
    await rt2.close();
  });

  it("a plugin's agent: listed to the manager each turn, started by spawn_agent agent with its instructions and tools, kept when it says so", async () => {
    const { SqliteStore } = await import('./store/sqlite.ts');
    const path = join(dir, 'spica.db');
    gw.onRequest((req) => {
      const all = JSON.stringify(req.body.messages);
      if (all.includes('PM-GO') && !all.includes('Started sub-agent')) {
        return {
          toolCalls: [
            { id: 's1', name: 'spawn_agent', args: { title: 'Watch', task: 'WATCH the samples', agent: 'notes__watcher', resident: false } },
            { id: 's2', name: 'spawn_agent', args: { title: 'Nope', task: 'x', agent: 'notes__nope' } },
          ],
        };
      }
      if (all.includes('WATCH')) return { text: 'watched' };
      return { text: 'ok' };
    });
    const rt1 = rtFor({ store: new SqliteStore(path) });
    rt1.registerTemplate(
      { id: 'notes__watcher', name: 'Watcher', role: 'worker', description: 'Follows up on samples', system: 'WATCHER-RULES', tools: ['read_file'], resident: true, plugin: 'Notes' },
      'plugin:notes',
    );
    // a plugin cannot take a built-in template's place
    expect(() => rt1.registerTemplate({ id: 'top', name: 'x', role: 'worker', system: 'x' }, 'plugin:bad')).toThrow(/already exists/);
    const p = rt1.createProject({ name: 'Part T1' });
    const pm = rt1.session(p.managerSessionId)!;
    await pm.send('PM-GO').done;
    const pmSystem = (gw.requests[0]!.body.messages as { content: string }[])[0]!.content;
    expect(pmSystem).toContain('Agents you can start with spawn_agent');
    expect(pmSystem).toContain('- notes__watcher: Watcher (Notes plugin, kept for later jobs): Follows up on samples');
    const kid = rt1.children(pm.id).find((k) => k.info().title === 'Watch')!;
    await kid.idle();
    // the agent says kept: asking for less does not undo that
    expect(kid.info()).toMatchObject({ templateId: 'notes__watcher', resident: true, status: 'idle', role: 'worker' });
    const kidReq = gw.requests.find((q) => JSON.stringify(q.body.messages).includes('WATCH the samples'))!;
    expect((kidReq.body.messages as { content: string }[])[0]!.content).toContain('WATCHER-RULES');
    expect(((kidReq.body.tools ?? []) as { name?: string; function?: { name: string } }[]).map((t) => t.function?.name ?? t.name)).toEqual(['read_file']);
    // a sub-agent is not given the list
    expect((kidReq.body.messages as { content: string }[])[0]!.content).not.toContain('Agents you can start');
    const unknown = pm.messages().flatMap((m) => m.content).find((x) => x.type === 'tool_result' && x.toolUseId === 's2');
    expect(unknown && 'content' in unknown ? unknown.content : '').toContain('No agent "notes__nope". Available: notes__watcher.');
    // the plugin restarts (an update): the agent goes and comes back, the sub-agent stays kept
    rt1.unregisterSource('plugin:notes');
    expect(rt1.agentTemplates()).toEqual([]);
    expect(kid.info()).toMatchObject({ resident: true, status: 'idle' });
    rt1.registerTemplate({ id: 'notes__watcher', name: 'Watcher', role: 'worker', system: 'WATCHER-RULES', resident: true, plugin: 'Notes' }, 'plugin:notes');
    // turned off: stopped, and the row says why
    expect(rt1.endPluginAgents('notes')).toBe(1);
    expect(kid.info()).toMatchObject({ status: 'aborted', stoppedBy: 'plugin' });
    expect(kid.info()).not.toHaveProperty('resident');
    // its manager is told (a note for the model, not shown to the user)
    const told = pm.messages().at(-1)!;
    expect(told).toMatchObject({ kind: 'note', meta: { author: 'runtime', pluginStopped: kid.id } });
    expect(JSON.stringify(told.content)).toContain('was stopped: the plugin it came from was turned off');
    await rt1.close();
    const rt2 = rtFor({ store: new SqliteStore(path) });
    rt2.restore();
    expect(rt2.session(kid.id)!.info()).toMatchObject({ status: 'aborted', stoppedBy: 'plugin', templateId: 'notes__watcher' });
    await rt2.close();
  });

  it("a plugin turned off while its agents are working: both stop (kept or not), its manager's wait ends and it is told; working again clears the mark", async () => {
    const { SqliteStore } = await import('./store/sqlite.ts');
    const path = join(dir, 'spica.db');
    gw.onRequest((req) => {
      const all = JSON.stringify(req.body.messages);
      if (all.includes('PM-GO') && !all.includes('Started sub-agent')) {
        return {
          toolCalls: [
            { id: 's1', name: 'spawn_agent', args: { title: 'Kept', task: 'SLOW-KEPT', agent: 'notes__kept' } },
            { id: 's2', name: 'spawn_agent', args: { title: 'Once', task: 'SLOW-ONCE', agent: 'notes__once' } },
          ],
        };
      }
      if (all.includes('PM-GO') && !all.includes('wait_agents')) return { toolCalls: [{ id: 'w1', name: 'wait_agents', args: { timeout_seconds: 60 } }] };
      if (all.includes('AGAIN')) return { text: 'again done' };
      if (all.includes('SLOW-')) return { text: 'late', delayMs: 4000 };
      return { text: 'ok' };
    });
    const rt1 = rtFor({ store: new SqliteStore(path) });
    rt1.registerTemplate({ id: 'notes__kept', name: 'Kept', role: 'worker', system: 'K', resident: true, plugin: 'Notes' }, 'plugin:notes');
    rt1.registerTemplate({ id: 'notes__once', name: 'Once', role: 'worker', system: 'O', plugin: 'Notes' }, 'plugin:notes');
    const p = rt1.createProject({ name: 'Part T1' });
    const pm = rt1.session(p.managerSessionId)!;
    const pmDone = pm.send('PM-GO').done;
    // both working, the manager waiting on them
    for (let i = 0; i < 100 && !(rt1.children(pm.id).length === 2 && rt1.children(pm.id).every((k) => k.running)); i++) await new Promise((r) => setTimeout(r, 30));
    const [kept, once] = ['Kept', 'Once'].map((t) => rt1.children(pm.id).find((k) => k.info().title === t)!);
    expect(kept!.running && once!.running).toBe(true);
    expect(rt1.endPluginAgents('notes')).toBe(2);
    await Promise.all([kept!.idle(), once!.idle()]);
    await pmDone;
    for (const k of [kept!, once!]) {
      expect(k.info()).toMatchObject({ status: 'aborted', stoppedBy: 'plugin' });
      expect(k.info()).not.toHaveProperty('resident');
    }
    const notes = pm.messages().filter((m) => m.meta?.pluginStopped);
    expect(notes.map((m) => m.meta?.pluginStopped).sort()).toEqual([kept!.id, once!.id].sort());
    await rt1.close();
    const rt2 = rtFor({ store: new SqliteStore(path) });
    rt2.restore();
    expect(rt2.session(once!.id)!.info()).toMatchObject({ status: 'aborted', stoppedBy: 'plugin' });
    // the user writes in it: it works again, and is no longer marked as stopped by its plugin
    await rt2.session(once!.id)!.send('AGAIN').done;
    expect(rt2.session(once!.id)!.info()).not.toHaveProperty('stoppedBy');
    await rt2.close();
  });

  it('a project holds sub-projects: their folders inside its own, one level only, a holder without a conversation', async () => {
    const rt = rtFor();
    const models = rt.createProject({ name: 'Models', manager: false });
    expect(models.managerSessionId).toBe('');
    expect(rt.sessions().some((s) => s.info().projectId === models.id)).toBe(false);
    const t1 = rt.createProject({ name: 'T1', parentId: models.id });
    expect(t1).toMatchObject({ parentId: models.id, folder: join(models.folder, 'T1') });
    expect(rt.session(t1.managerSessionId)!.info()).toMatchObject({ role: 'manager', parentId: null, projectId: t1.id, cwd: t1.folder });
    // a relative folder is taken from the project's folder; one outside it is refused
    expect(rt.createProject({ name: 'L1', parentId: models.id, folder: 'coils/L1' }).folder).toBe(join(models.folder, 'coils', 'L1'));
    expect(() => rt.createProject({ name: 'Out', parentId: models.id, folder: join(dir, 'elsewhere') })).toThrow(/inside its project's folder/);
    expect(() => rt.createProject({ name: 'Up', parentId: models.id, folder: '../up' })).toThrow(/inside its project's folder/);
    expect(() => rt.createProject({ name: 'Same', parentId: models.id, folder: models.folder })).toThrow(/inside its project's folder/);
    // one level: a sub-project holds no sub-projects; a sub-project is a conversation
    expect(() => rt.createProject({ name: 'Deep', parentId: t1.id })).toThrow(/holds no sub-projects/);
    expect(() => rt.createProject({ name: 'Bare', parentId: models.id, manager: false })).toThrow(/needs its manager/);
    expect(() => rt.createProject({ name: 'Lost', parentId: 'prj_nope' })).toThrow(/unknown project/);
    const d = rt.getProject(models.id)!;
    expect(d.manager).toBeNull();
    expect(d.agents).toEqual([]);
    expect(d.subProjects.map((p) => p.name)).toEqual(['T1', 'L1']);
    expect(rt.getProject(t1.id)).toMatchObject({ manager: { id: t1.managerSessionId }, subProjects: [] });
    // renaming the holder touches no conversation
    expect(rt.renameProject(models.id, 'Models 2').name).toBe('Models 2');
    // a project with a conversation of its own can hold sub-projects too
    const old = rt.createProject({ name: 'Old' });
    const sub = rt.createProject({ name: 'Part', parentId: old.id });
    expect(rt.getProject(old.id)).toMatchObject({ manager: { id: old.managerSessionId }, subProjects: [{ id: sub.id }] });
  });

  it('deleting a project deletes its sub-projects and their conversations (the folders stay)', async () => {
    const rt = rtFor();
    const events: { type: string; projectId?: string }[] = [];
    rt.events.on((e) => events.push(e as { type: string; projectId?: string }));
    const models = rt.createProject({ name: 'Models', manager: false });
    const t1 = rt.createProject({ name: 'T1', parentId: models.id });
    const worker = rt.createSession({ parentId: t1.managerSessionId });
    const other = rt.createProject({ name: 'Other' });
    await rt.deleteProject(models.id);
    expect(rt.listProjects().map((p) => p.id)).toEqual([other.id]);
    expect(rt.session(t1.managerSessionId)).toBeUndefined();
    expect(rt.session(worker.id)).toBeUndefined();
    expect(rt.session(other.managerSessionId)).toBeDefined();
    expect(events.filter((e) => e.type === 'project.deleted').map((e) => e.projectId)).toEqual([t1.id, models.id]);
    const { stat } = await import('node:fs/promises');
    expect((await stat(t1.folder)).isDirectory()).toBe(true);
  });

  it('sub-projects survive a restart, also in a database made before projects had a parent', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { SqliteStore } = await import('./store/sqlite.ts');
    const path = join(dir, 'old.db');
    // the projects table as earlier builds made it (no parent_id)
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL, manager_session_id TEXT NOT NULL,
      workflow_id TEXT, stage TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      unread INTEGER NOT NULL DEFAULT 0)`);
    old.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('prj_old', 'Before', join(dir, 'Before'), '', null, null, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0);
    old.close();
    const rt1 = rtFor({ store: new SqliteStore(path) });
    rt1.restore();
    expect(rt1.listProjects()).toEqual([expect.objectContaining({ id: 'prj_old', name: 'Before' })]);
    expect(rt1.listProjects()[0]).not.toHaveProperty('parentId');
    const models = rt1.createProject({ name: 'Models', manager: false });
    const t1 = rt1.createProject({ name: 'T1', parentId: models.id });
    await rt1.close();
    const rt2 = rtFor({ store: new SqliteStore(path) });
    rt2.restore();
    expect(rt2.getProject(t1.id)).toMatchObject({ parentId: models.id, manager: { id: t1.managerSessionId, parentId: null } });
    expect(rt2.getProject(models.id)).toMatchObject({ managerSessionId: '', manager: null, subProjects: [{ id: t1.id }] });
    await rt2.close();
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

describe('project tools', () => {
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
  const names = (r: ReturnType<typeof makeRuntime>, s: ReturnType<ReturnType<typeof makeRuntime>['createSession']>) => {
    const i = s.info();
    return r.tools.list({ providerId: i.providerId, serverWebSearch: false, role: i.role, ...(i.projectId ? { projectId: i.projectId } : {}) }, s.config.tools).map((t) => t.spec.name);
  };

  it('top-level tools only for the top-level agent, project tools only inside a project', () => {
    const r = makeRuntime(gw, { cwd: dir, workflowsDir: exampleDir });
    const p = r.createProject({ name: 'P', workflowId: 'product-development' });
    const topTools = names(r, r.top());
    expect(topTools).toEqual(expect.arrayContaining(['create_project', 'list_projects', 'open_project', 'message_agent']));
    expect(topTools).not.toContain('set_stage');
    const pmTools = names(r, r.session(p.managerSessionId)!);
    expect(pmTools).toEqual(expect.arrayContaining(['project_status', 'set_stage', 'add_work_object', 'list_work_objects', 'spawn_agent']));
    // a manager creates sub-projects of its project
    expect(pmTools).toContain('create_project');
    // a plain top-level chat may start projects; a sub-agent outside a project sees neither set
    expect(names(r, r.createSession())).toContain('create_project');
    const worker = names(r, r.createSession({ parentId: r.createSession().id }));
    expect(worker).not.toContain('create_project');
    expect(worker).not.toContain('project_status');
  });

  it('the top-level agent creates a project; the manager sees its project and uses the stage tools', async () => {
    gw.onRequest((req) => {
      const all = JSON.stringify(req.body.messages);
      if (all.includes('TOP-ASK') && !all.includes('Created project')) {
        return { toolCalls: [{ id: 'c1', name: 'create_project', args: { name: 'Lamp', workflow: 'product-development', brief: 'PM-BRIEF' } }] };
      }
      if (all.includes('PM-BRIEF') && !all.includes('Added [product]')) {
        return { toolCalls: [{ id: 'a1', name: 'add_work_object', args: { level: 'product', name: 'Desk lamp' } }] };
      }
      if (all.includes('PM-BRIEF') && !all.includes('Stage is now')) {
        return { toolCalls: [{ id: 's1', name: 'set_stage', args: { stage: 'pilot', note: 'samples ok' } }] };
      }
      return { text: 'done' };
    });
    const r = makeRuntime(gw, { cwd: dir, workflowsDir: exampleDir });
    const top = r.top();
    await top.send('TOP-ASK make a lamp project').done;
    const p = r.listProjects()[0]!;
    const pm = r.session(p.managerSessionId)!;
    await pm.idle();
    expect(r.getProject(p.id)).toMatchObject({ stage: 'pilot', objects: [{ name: 'Desk lamp', level: 'product' }] });
    const pmRequest = gw.requests.find((q) => JSON.stringify(q.body.messages).includes('PM-BRIEF'))!;
    const system = (pmRequest.body.messages as { content: string }[])[0]!.content;
    expect(system).toContain(`You work for the project "Lamp" (${p.id})`);
    expect(system).toContain('current stage: Sample (goal: Build samples that prove the function)');
    // the stage change is in the project's activity; the assistant reads it there (list_projects / open_project)
    expect(r.getProject(p.id)!.recentLog.some((e) => e.action === 'stage')).toBe(true);
    void top;
  });

  it('the top-level agent creates a project holding sub-projects; a manager creates one beside its own', async () => {
    gw.onRequest((req) => {
      const all = JSON.stringify(req.body.messages);
      if (all.includes('TOP-ASK') && !all.includes('Created project')) {
        return { toolCalls: [{ id: 'c1', name: 'create_project', args: { name: 'Models', manager: false } }] };
      }
      if (all.includes('TOP-ASK') && !all.includes('Created sub-project')) {
        return { toolCalls: [{ id: 'c2', name: 'create_project', args: { name: 'T1', parent: 'Models', brief: 'T1-BRIEF' } }] };
      }
      if (all.includes('T1-BRIEF') && !all.includes('Created sub-project')) {
        return { toolCalls: [{ id: 'c3', name: 'create_project', args: { name: 'L1', parent: 'ignored' } }] };
      }
      return { text: 'done' };
    });
    const r = makeRuntime(gw, { cwd: dir, workflowsDir: exampleDir });
    await r.top().send('TOP-ASK models with T1').done;
    const models = r.listProjects().find((p) => p.name === 'Models')!;
    const t1 = r.listProjects().find((p) => p.name === 'T1')!;
    expect(models.managerSessionId).toBe('');
    expect(t1.parentId).toBe(models.id);
    await r.session(t1.managerSessionId)!.idle();
    // the sub-project's manager made a sibling (its own project is a sub-project)
    expect(r.listProjects().find((p) => p.name === 'L1')).toMatchObject({ parentId: models.id, folder: join(models.folder, 'L1') });
    const t1Request = gw.requests.find((q) => JSON.stringify(q.body.messages).includes('T1-BRIEF'))!;
    expect((t1Request.body.messages as { content: string }[])[0]!.content).toContain(`It is a sub-project of "Models" (${models.id}`);
  });
});

describe('team rule', () => {
  it('sessions that lead sub-agents are told that user changes in a sub-agent session take priority', async () => {
    const gw = await startGateway();
    try {
      gw.onRequest(() => ({ text: 'ok' }));
      const r = makeRuntime(gw);
      const lead = r.createSession({ role: 'worker' }); // not a leader yet
      await lead.send('one').done;
      const child = r.createSession({ parentId: lead.id });
      await lead.send('two').done;
      await child.send('three', { author: 'parent' }).done;
      const sys = (i: number) => (gw.requests[i]!.body.messages as { content: string }[])[0]!.content;
      const { TEAM_RULE } = await import('./session.ts');
      expect(sys(0)).not.toContain(TEAM_RULE);
      expect(sys(1)).toContain(TEAM_RULE); // now it has a sub-agent
      expect(sys(2)).not.toContain(TEAM_RULE); // the sub-agent itself leads no one
    } finally {
      await gw.stop();
    }
  });
});

describe('top-level threads', () => {
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

  it('every parentless session is a thread of the top-level agent', async () => {
    gw.onRequest(() => ({ text: 'ok' }));
    const r = makeRuntime(gw, { cwd: dir });
    const a = r.createSession();
    const b = r.createSession();
    await new Promise((res) => setTimeout(res, 5));
    await b.send('used last').done;
    expect([a.info().templateId, b.info().templateId]).toEqual(['top', 'top']);
    expect(r.top().id).toBe(b.id); // no conversation is special: top() is the one used most recently
    expect(r.top().id).not.toBe(r.createSession({ role: 'worker' }).id);
    expect(r.createSession({ role: 'worker' }).info().templateId).toBeUndefined();
  });

  it('another thread can wait for a project manager it did not parent, and gets the report inline', async () => {
    gw.onRequest((req) => {
      const all = JSON.stringify(req.body.messages);
      if (all.includes('THREAD-2') && !all.includes('Created project')) {
        return { toolCalls: [{ id: 'c1', name: 'create_project', args: { name: 'Q', brief: 'PM-JOB' } }] };
      }
      if (all.includes('THREAD-2') && !all.includes('finished')) return { toolCalls: [{ id: 'w1', name: 'wait_agents', args: {} }] };
      if (all.includes('PM-JOB')) return { text: 'PM-REPORT-TEXT', delayMs: 100 };
      return { text: 'thread done' };
    });
    const r = makeRuntime(gw, { cwd: dir });
    r.top(); // default thread exists first
    const thread2 = r.createSession();
    const res = await thread2.send('THREAD-2 start a project and wait for it').done;
    expect(res.reason).toBe('completed');
    const waitResult = JSON.stringify(thread2.messages().filter((m) => m.kind === 'tool_results').at(-1)!.content);
    expect(waitResult).toContain('All requested sub-agents have finished');
    expect(waitResult).toContain('PM-REPORT-TEXT');
    const pm = r.session(r.listProjects()[0]!.managerSessionId)!;
    expect(pm.parentId).toBeNull();
    // the conversation that created it got the manager's report as a note
    expect(thread2.messages().some((m) => m.kind === 'report' && JSON.stringify(m.content).includes('PM-REPORT-TEXT'))).toBe(true);
    expect(r.canDirect(thread2.id, pm.id)).toBe(true);
    expect(r.canDirect(r.createSession({ role: 'worker' }).id, pm.id)).toBe(false);
  });

  it('commands that only sleep are refused before any confirmation, with a pointer to wait_agents', async () => {
    gw.enqueue({ toolCalls: [{ id: 'z1', name: 'run_command', args: { command: 'Start-Sleep -Seconds 45' } }] }, { text: 'ok' });
    const r = makeRuntime(gw, { cwd: dir });
    const s = r.createSession();
    const res = await s.send('wait a bit').done;
    expect(res.reason).toBe('completed'); // no awaiting_confirm
    expect(JSON.stringify(s.messages()[2]!.content)).toContain('use wait_agents');
  });
});
