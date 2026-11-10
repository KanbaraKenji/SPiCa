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
    expect(pmTools).not.toContain('create_project');
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
