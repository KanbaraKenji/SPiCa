// Renaming and deleting a project from the left column.
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteStore } from './store/sqlite.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, tempDir, until } from './testing/helpers.ts';
import type { MailItem } from './types.ts';

// gateways, child processes and local servers start slowly when several full runs share the machine
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

const mail = (id: string, projectId: string): MailItem => ({
  id: `box:${id}`,
  sourceId: 'box',
  messageId: id,
  fromAddress: `${id}@example.com`,
  subject: `mail ${id}`,
  status: 'routed',
  triage: { decision: 'project', projectId, reason: 'about it', confidence: 0.9, by: 'model', at: '2026-11-10T09:00:00+08:00' },
  routedTo: 'x',
  createdAt: '2026-11-10T09:00:00+08:00',
  updatedAt: '2026-11-10T09:00:00+08:00',
});

describe('project rename and delete', () => {
  it('rename changes the project and its manager title', async () => {
    const rt = makeRuntime(gw, { cwd: dir, projectsRoot: dir });
    const events = captureEvents(rt);
    const p = rt.createProject({ name: 'Old name' });
    const renamed = rt.renameProject(p.id, '  New name ');
    expect(renamed.name).toBe('New name');
    expect(rt.session(p.managerSessionId)!.info().title).toBe('New name');
    expect(events.find((e) => e.type === 'project.updated')).toMatchObject({ project: { id: p.id, name: 'New name' } });
    expect(() => rt.renameProject(p.id, ' ')).toThrow(/needs a name/);
    expect(() => rt.renameProject('nope', 'x')).toThrow(/unknown project/);
  });

  it('delete removes the records, stops what runs, keeps the folder, and frees its mail', async () => {
    const path = join(dir, 'db', 'spica.db');
    const rt = makeRuntime(gw, { cwd: dir, projectsRoot: dir, store: new SqliteStore(path) });
    const events = captureEvents(rt);
    const gone = rt.createProject({ name: 'Gone' });
    const kept = rt.createProject({ name: 'Kept' });
    await writeFile(join(gone.folder, 'plan.md'), '# plan\n');
    const pm = rt.session(gone.managerSessionId)!;
    // the manager has finished one run; its sub-agent is mid-call when the project is deleted
    gw.enqueue({ text: 'planned', usage: { input: 100, output: 10 } });
    await pm.send('plan it').done;
    const worker = rt.createSession({ parentId: pm.id, title: 'helper' });
    gw.enqueue({ text: 'slow', delayMs: 2000 });
    void worker.send('work').done;
    await until(() => worker.status === 'thinking');
    rt.logProjectActivity(pm, 'note', 'noted', 'x');
    rt.store.upsertMail(mail('m1', gone.id));
    rt.store.upsertMail(mail('m2', kept.id));
    rt.store.setSenderDecision('m1@example.com', { decision: 'project', projectId: gone.id });
    rt.store.setSenderDecision('m2@example.com', { decision: 'project', projectId: kept.id });
    const tracesBefore = rt.store.listTraces().length;

    await rt.deleteProject(gone.id);

    expect(worker.running).toBe(false);
    for (const id of [pm.id, worker.id]) {
      expect(rt.session(id)).toBeUndefined();
      expect(rt.store.getSession(id)).toBeUndefined();
      expect(rt.store.listMessages(id)).toEqual([]);
    }
    expect(rt.store.getProject(gone.id)).toBeUndefined();
    expect(rt.store.listProjectLog(gone.id)).toEqual([]);
    expect(existsSync(join(gone.folder, 'plan.md'))).toBe(true); // files are not touched
    const freed = rt.store.getMail('box:m1')!;
    expect(freed).toMatchObject({ status: 'triaged', triage: { decision: 'new' } });
    expect(freed.triage?.projectId).toBeUndefined();
    expect(freed.routedTo).toBeUndefined();
    expect(rt.store.getSenderDecision('m1@example.com')).toBeUndefined();
    // the other project is untouched
    expect(rt.store.getMail('box:m2')!.triage?.projectId).toBe(kept.id);
    expect(rt.store.getSenderDecision('m2@example.com')).toEqual({ decision: 'project', projectId: kept.id });
    expect(rt.session(kept.managerSessionId)).toBeDefined();
    // spending history stays
    expect(rt.store.listTraces().length).toBeGreaterThanOrEqual(tracesBefore);
    expect(events.filter((e) => e.type === 'session.deleted').map((e) => e.sessionId).sort()).toEqual([pm.id, worker.id].sort());
    expect(events.find((e) => e.type === 'project.deleted')).toMatchObject({ projectId: gone.id });
    await rt.close();

    // nothing comes back after a restart
    const rt2 = makeRuntime(gw, { cwd: dir, projectsRoot: dir, store: new SqliteStore(path) });
    rt2.restore();
    expect(rt2.listProjects().map((p) => p.name)).toEqual(['Kept']);
    expect(rt2.sessions().some((s) => s.id === pm.id || s.id === worker.id)).toBe(false);
    await rt2.close();
  });
});
